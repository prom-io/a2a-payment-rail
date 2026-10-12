import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { FeeLedgerService } from '../src/modules/fees/fee-ledger.service';

describe('Fees (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let agentToken: string;
  // A chain of its own per run, so the ledger assertions do not depend on what
  // earlier runs left in the database.
  const chainId = 900_000 + Math.floor(Math.random() * 90_000);
  const recipient = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const jwt = app.get(JwtService);
    adminToken = jwt.sign({ sub: 'ops-1', address: recipient, role: 'admin' });
    agentToken = jwt.sign({ sub: 'agent-1', address: recipient, role: 'agent' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('quotes the default 50 bps fee', async () => {
    const res = await request(app.getHttpServer()).get('/fees/quote').query({ amount: '2' }).expect(200);
    expect(res.body).toMatchObject({ fee: '0.01', net: '1.99', bps: 50, bound: 'none' });
  });

  it('rejects a malformed amount', async () => {
    await request(app.getHttpServer()).get('/fees/quote').query({ amount: '1e18' }).expect(400);
  });

  it('lists fee policies', async () => {
    const res = await request(app.getHttpServer()).get('/fees/policies').expect(200);
    expect(res.body[0]).toMatchObject({ chainId: 'default', bps: 50 });
  });

  it('starts a chain with an empty ledger', async () => {
    const res = await request(app.getHttpServer()).get('/fees/ledger').query({ chainId }).expect(200);
    expect(res.body.balance).toEqual({ chainId, accrued: '0.0', withdrawn: '0.0', available: '0.0' });
    expect(res.body.entries).toEqual([]);
  });

  it('only lets an admin withdraw', async () => {
    const body = { amount: '0.1', recipient, chainId };
    await request(app.getHttpServer()).post('/fees/withdrawals').send(body).expect(401);
    await request(app.getHttpServer())
      .post('/fees/withdrawals')
      .set('Authorization', `Bearer ${agentToken}`)
      .send(body)
      .expect(403);
  });

  it('refuses to withdraw more than was accrued', async () => {
    await request(app.getHttpServer())
      .post('/fees/withdrawals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: '0.1', recipient, chainId })
      .expect(409);
  });

  it('withdraws accrued fees and keeps the balance consistent', async () => {
    const ledger = app.get(FeeLedgerService);
    await ledger.accrue({ id: randomUUID(), feeAmount: '0.5' }, chainId);
    await ledger.accrue({ id: randomUUID(), feeAmount: '0.25' }, chainId);

    const withdrawal = await request(app.getHttpServer())
      .post('/fees/withdrawals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: '0.6', recipient, chainId, note: 'e2e payout' })
      .expect(201);
    expect(withdrawal.body.balance).toEqual({
      chainId,
      accrued: '0.75',
      withdrawn: '0.6',
      available: '0.15',
    });

    await request(app.getHttpServer())
      .post('/fees/withdrawals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: '0.2', recipient, chainId })
      .expect(409);

    const res = await request(app.getHttpServer()).get('/fees/ledger').query({ chainId }).expect(200);
    expect(res.body.balance.available).toBe('0.15');
    expect(res.body.entries).toHaveLength(3);
  });
});
