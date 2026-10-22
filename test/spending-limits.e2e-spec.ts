import { randomBytes } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Spending limits (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  // Fresh payers per run: the window looks at everything a payer opened in 24h.
  const payer = '0x' + randomBytes(20).toString('hex');
  const unlimitedPayer = '0x' + randomBytes(20).toString('hex');

  const open = (agentA: string, depositAmount: number) =>
    request(app.getHttpServer()).post('/escrow').send({
      agentA,
      agentB: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      depositAmount,
      budgetLimit: depositAmount,
      ttl: 3600,
    });
  // The short throttler allows 10 calls per second per route; let the window pass.
  const cooldown = () => new Promise((resolve) => setTimeout(resolve, 1_100));
  const status = async (address: string) =>
    (await request(app.getHttpServer()).get(`/spending-limits/${address}`).expect(200)).body;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    adminToken = app.get(JwtService).sign({ sub: 'ops-1', address: payer, role: 'admin' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports an unlimited payer by default', async () => {
    expect(await status(payer)).toMatchObject({ payer, dailyLimit: null, remaining: null, spent: '0.0' });
  });

  it('only lets an admin set a limit', async () => {
    await request(app.getHttpServer()).put(`/spending-limits/${payer}`).send({ dailyLimit: '5' }).expect(401);

    const res = await request(app.getHttpServer())
      .put(`/spending-limits/${payer}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ dailyLimit: '5' })
      .expect(200);
    expect(res.body).toMatchObject({ dailyLimit: '5.0', source: 'override', remaining: '5.0' });
  });

  it('rejects a malformed limit or address', async () => {
    await request(app.getHttpServer())
      .put(`/spending-limits/${payer}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ dailyLimit: '-5' })
      .expect(400);
    await request(app.getHttpServer()).get('/spending-limits/0x123').expect(400);
  });

  it('opens escrows up to the limit and refuses the one that would exceed it', async () => {
    await open(payer, 2).expect(201);
    await open(payer, 3).expect(201);

    const refused = await open(payer, 1).expect(403);
    expect(refused.body.message).toMatch(/Spending limit exceeded/);

    expect(await status(payer)).toMatchObject({ spent: '5.0', remaining: '0.0' });
  });

  it('never lets concurrent opens exceed the limit together', async () => {
    await cooldown();
    const racer = '0x' + randomBytes(20).toString('hex');
    await request(app.getHttpServer())
      .put(`/spending-limits/${racer}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ dailyLimit: '3' })
      .expect(200);

    const results = await Promise.all([1, 2, 3, 4, 5].map(() => open(racer, 1)));

    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 403, 403]);
    expect((await status(racer)).spent).toBe('3.0');
  });

  it('does not limit other payers', async () => {
    await open(unlimitedPayer, 50).expect(201);
  });

  it('frees the limit again when a session is cancelled', async () => {
    await cooldown();
    const fresh = '0x' + randomBytes(20).toString('hex');
    await request(app.getHttpServer())
      .put(`/spending-limits/${fresh}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ dailyLimit: '2' })
      .expect(200);
    const escrow = await open(fresh, 2).expect(201);
    await open(fresh, 1).expect(403);

    await request(app.getHttpServer()).post(`/escrow/${escrow.body.id}/cancel`).expect(200);

    await open(fresh, 1).expect(201);
  });

  it('falls back to no limit once the override is removed', async () => {
    await request(app.getHttpServer())
      .delete(`/spending-limits/${payer}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    expect(await status(payer)).toMatchObject({ dailyLimit: null, source: 'none' });
    await open(payer, 1).expect(201);
  });
});
