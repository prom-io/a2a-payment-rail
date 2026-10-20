import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Partial escrow release (e2e)', () => {
  let app: INestApplication;
  let escrowId: string;

  const openEscrow = async (depositAmount: number, budgetLimit = depositAmount): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/escrow')
      .send({
        agentA: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        agentB: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        depositAmount,
        budgetLimit,
        ttl: 3600,
      })
      .expect(201);
    return res.body.id;
  };
  const release = (id: string, amount: string) =>
    request(app.getHttpServer()).post(`/escrow/${id}/release`).send({ amount });
  // The short throttler allows 10 calls per second per route; let the window pass.
  const cooldown = () => new Promise((resolve) => setTimeout(resolve, 1_100));
  const balance = async (id: string) =>
    (await request(app.getHttpServer()).get(`/escrow/${id}/balance`).expect(200)).body;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    escrowId = await openEscrow(3);
  });

  afterAll(async () => {
    await app.close();
  });

  it('starts with the whole deposit remaining', async () => {
    expect(await balance(escrowId)).toMatchObject({
      escrowId,
      status: 'open',
      depositAmount: '3.0',
      releasedAmount: '0.0',
      remainingBalance: '3.0',
    });
  });

  it('releases part of the escrow and keeps the session open', async () => {
    const res = await release(escrowId, '1.25').expect(201);

    expect(res.body.release).toMatchObject({ escrowId, status: 'completed' });
    expect(res.body.balance).toMatchObject({ releasedAmount: '1.25', remainingBalance: '1.75', status: 'open' });
  });

  it('rejects a release above the remaining balance without changing it', async () => {
    await release(escrowId, '1.750000000000000001').expect(409);
    expect((await balance(escrowId)).remainingBalance).toBe('1.75');
  });

  it('rejects malformed amounts', async () => {
    await release(escrowId, '-1').expect(400);
    await release(escrowId, '1e3').expect(400);
    await release(escrowId, '0').expect(400);
  });

  it('releases the exact remainder and then nothing more', async () => {
    await release(escrowId, '1.75').expect(201);
    expect((await balance(escrowId)).remainingBalance).toBe('0.0');
    await release(escrowId, '0.000000000000000001').expect(409);
  });

  it('lists the releases of the session in order', async () => {
    const res = await request(app.getHttpServer()).get(`/escrow/${escrowId}/releases`).expect(200);
    expect(res.body.map((r: { amount: string }) => Number(r.amount))).toEqual([1.25, 1.75]);
  });

  it('never lets concurrent releases take more than the session holds', async () => {
    await cooldown();
    const id = await openEscrow(2);

    const results = await Promise.all(Array.from({ length: 5 }, () => release(id, '0.5')));

    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 201, 409]);
    expect(await balance(id)).toMatchObject({ releasedAmount: '2.0', remainingBalance: '0.0' });
  });

  it('caps releases at the budget limit', async () => {
    await cooldown();
    const id = await openEscrow(5, 2);
    await release(id, '2.5').expect(409);
    await release(id, '2').expect(201);
  });

  it('refuses to release from a closed session and refunds only what was not released', async () => {
    const id = await openEscrow(3);
    await release(id, '1').expect(201);
    await request(app.getHttpServer()).post(`/escrow/${id}/cancel`).expect(200);

    await release(id, '1').expect(409);

    const refund = await request(app.getHttpServer()).post(`/refunds/${id}`).expect(200);
    expect(Number(refund.body.spentAmount)).toBeCloseTo(1, 12);
    expect(Number(refund.body.refundAmount)).toBeCloseTo(2, 12);
  });
});
