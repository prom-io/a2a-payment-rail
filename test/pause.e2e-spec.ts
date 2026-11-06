import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { SettlementBatchScheduler } from '../src/modules/settlement/settlement-batch.scheduler';

describe('Emergency pause (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  const escrowId = randomUUID();

  const admin = (method: 'get' | 'post', path: string) =>
    request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${adminToken}`);
  const settle = () =>
    request(app.getHttpServer())
      .post('/settlements/batch')
      .send({ escrowId, receiptsHash: '0x' + 'ab'.repeat(32), totalAmount: 1 });
  const claim = () => request(app.getHttpServer()).post('/streaming/claim').send({ escrowId, usageDelta: 1 });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    adminToken = app.get(JwtService).sign({ sub: 'ops-e2e', address: '0x0', role: 'admin' });
  });

  afterAll(async () => {
    // The switch lives in the database: never leave it on for the next suite.
    await admin('post', '/admin/resume').send({ scope: 'all' });
    await app.close();
  });

  it('is off by default and only visible to admins', async () => {
    await request(app.getHttpServer()).get('/admin/pause').expect(401);
    await request(app.getHttpServer()).post('/admin/pause').send({ scope: 'all', reason: 'nope' }).expect(401);

    const res = await admin('get', '/admin/pause').expect(200);
    expect(res.body.settlement.paused).toBe(false);
    expect(res.body.streaming.paused).toBe(false);
  });

  it('requires a known scope and a reason', async () => {
    await admin('post', '/admin/pause').send({ scope: 'everything', reason: 'drill' }).expect(400);
    await admin('post', '/admin/pause').send({ scope: 'settlement' }).expect(400);
  });

  it('pauses settlements with 503 and leaves streaming alone', async () => {
    const paused = await admin('post', '/admin/pause')
      .send({ scope: 'settlement', reason: 'e2e drill' })
      .expect(200);
    expect(paused.body.settlement).toMatchObject({ paused: true, source: 'api', pausedBy: 'ops-e2e' });

    const refused = await settle().expect(503);
    expect(refused.body.message).toBe('settlement is paused by the operator: e2e drill');
    await claim().expect(201);
  });

  it('stops the batch scheduler while paused', async () => {
    const result = await app.get(SettlementBatchScheduler).runOnce(new Date(Date.now() + 3_600_000));
    expect(result).toMatchObject({ ran: false, batches: 0 });
  });

  it('reports the pause on the health endpoint', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.paused).toEqual({ settlement: true, streaming: false });
  });

  it('still lets a payer cancel and get a refund while payouts are paused', async () => {
    const escrow = await request(app.getHttpServer())
      .post('/escrow')
      .send({
        agentA: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        agentB: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        depositAmount: 1,
        budgetLimit: 1,
        ttl: 3600,
      })
      .expect(201);

    await request(app.getHttpServer()).post(`/escrow/${escrow.body.id}/release`).send({ amount: '0.5' }).expect(503);
    await request(app.getHttpServer()).post(`/escrow/${escrow.body.id}/cancel`).expect(200);
    await request(app.getHttpServer()).post(`/refunds/${escrow.body.id}`).expect(200);
  });

  it('pauses stream claims too, then resumes everything', async () => {
    await admin('post', '/admin/pause').send({ scope: 'all', reason: 'e2e drill' }).expect(200);
    await claim().expect(503);

    const resumed = await admin('post', '/admin/resume').send({ scope: 'all' }).expect(200);
    expect(resumed.body.settlement.paused).toBe(false);
    expect(resumed.body.streaming.paused).toBe(false);

    await settle().expect(201);
    await claim().expect(201);
  });
});
