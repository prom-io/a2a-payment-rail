import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { SettlementBatchScheduler } from '../src/modules/settlement/settlement-batch.scheduler';

describe('Batch settlement scheduler (e2e)', () => {
  let app: INestApplication;
  let scheduler: SettlementBatchScheduler;
  const escrowId = randomUUID();
  const sessionId = randomUUID();

  const postReceipt = (index: number, amount: number) =>
    request(app.getHttpServer())
      .post('/receipts')
      .send({
        escrowId,
        sessionId,
        fromAgent: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        toAgent: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        amount,
        // unique per run so reruns against the same database do not collide
        receiptHash: '0x' + (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 62) + '0' + index,
        signature: '0x' + 'ab'.repeat(65),
      })
      .expect(201);

  const settlementsOfEscrow = async () => {
    const res = await request(app.getHttpServer()).get('/settlements').query({ escrowId }).expect(200);
    return res.body as Array<Record<string, any>>;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    scheduler = app.get(SettlementBatchScheduler);
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts receipts and leaves them unsettled inside the window', async () => {
    await postReceipt(1, 0.2);
    await postReceipt(2, 0.3);
    await postReceipt(3, 0.25);

    const result = await scheduler.runOnce(new Date());

    expect(result.ran).toBe(true);
    expect(await settlementsOfEscrow()).toHaveLength(0);
  });

  it('settles the escrow in one batch once the window has elapsed', async () => {
    // Default window is 60s; run the scheduler as if two minutes had passed.
    const result = await scheduler.runOnce(new Date(Date.now() + 120_000));
    expect(result.batches).toBeGreaterThanOrEqual(1);

    const settlements = await settlementsOfEscrow();
    expect(settlements).toHaveLength(1);
    expect(settlements[0].receiptCount).toBe(3);
    expect(Number(settlements[0].totalAmount)).toBeCloseTo(0.75, 12);
    expect(settlements[0].receiptsHash).toMatch(/^0x[0-9a-f]{64}$/);
    // The compact calldata blob is stored but kept out of list responses.
    expect(settlements[0].packedReceipts).toBeUndefined();
  });

  it('does not batch the same receipts twice', async () => {
    await scheduler.runOnce(new Date(Date.now() + 240_000));
    expect(await settlementsOfEscrow()).toHaveLength(1);
  });

  it('batches receipts that arrive later into a new settlement', async () => {
    await postReceipt(4, 0.1);
    await scheduler.runOnce(new Date(Date.now() + 120_000));

    const settlements = await settlementsOfEscrow();
    expect(settlements).toHaveLength(2);
    expect(settlements.map((s) => s.receiptCount).sort()).toEqual([1, 3]);
  });

  it('lists the dead-letter queue', async () => {
    const res = await request(app.getHttpServer()).get('/settlements/dead-letter').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('does not let an anonymous caller replay a settlement', async () => {
    const [settlement] = await settlementsOfEscrow();
    await request(app.getHttpServer()).post(`/settlements/${settlement.id}/replay`).expect(401);
  });
});
