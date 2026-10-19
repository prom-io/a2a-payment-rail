import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { RefundsService } from '../src/modules/refunds/refunds.service';

describe('Refunds (e2e)', () => {
  let app: INestApplication;

  const openEscrow = async (depositAmount: number, ttl = 3600): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/escrow')
      .send({
        agentA: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        agentB: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        depositAmount,
        budgetLimit: depositAmount,
        ttl,
      })
      .expect(201);
    return res.body.id;
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
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses to refund a session that is still open', async () => {
    const id = await openEscrow(1);
    await request(app.getHttpServer()).post(`/refunds/${id}`).expect(409);
    await request(app.getHttpServer()).get(`/refunds/${id}`).expect(404);
  });

  it('cancels an open session and refunds its deposit once', async () => {
    const id = await openEscrow(1.5);

    const cancelled = await request(app.getHttpServer()).post(`/escrow/${id}/cancel`).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    await request(app.getHttpServer()).post(`/escrow/${id}/cancel`).expect(409);

    const refund = await request(app.getHttpServer()).post(`/refunds/${id}`).expect(200);
    expect(refund.body).toMatchObject({
      escrowId: id,
      reason: 'cancelled',
      status: 'completed',
    });
    expect(Number(refund.body.refundAmount)).toBeCloseTo(1.5, 12);

    const again = await request(app.getHttpServer()).post(`/refunds/${id}`).expect(200);
    expect(again.body.id).toBe(refund.body.id);

    const stored = await request(app.getHttpServer()).get(`/refunds/${id}`).expect(200);
    expect(stored.body.id).toBe(refund.body.id);
  });

  it('subtracts stream claims from the refund', async () => {
    const id = await openEscrow(3);
    await request(app.getHttpServer()).post('/streaming/claim').send({ escrowId: id, usageDelta: 1 }).expect(201);
    await request(app.getHttpServer()).post(`/escrow/${id}/cancel`).expect(200);

    const refund = await request(app.getHttpServer()).post(`/refunds/${id}`).expect(200);

    expect(Number(refund.body.spentAmount)).toBeCloseTo(1, 12);
    expect(Number(refund.body.refundAmount)).toBeCloseTo(2, 12);
  });

  it('expires sessions past their TTL and refunds them in the sweep', async () => {
    const shortLived = await openEscrow(1, 60);
    const longLived = await openEscrow(1, 604800);

    // run the sweep as if two minutes had passed: only the 60s session is due
    const result = await app.get(RefundsService).sweep(new Date(Date.now() + 120_000));
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    const expired = await request(app.getHttpServer()).get(`/escrow/${shortLived}`).expect(200);
    expect(expired.body.status).toBe('expired');
    expect(expired.body.refundedAt).toBeTruthy();
    const refund = await request(app.getHttpServer()).get(`/refunds/${shortLived}`).expect(200);
    expect(refund.body).toMatchObject({ reason: 'expired', status: 'completed' });

    const alive = await request(app.getHttpServer()).get(`/escrow/${longLived}`).expect(200);
    expect(alive.body.status).toBe('open');
    await request(app.getHttpServer()).get(`/refunds/${longLived}`).expect(404);
  });

  it('answers 404 for an unknown escrow and 400 for a malformed id', async () => {
    await request(app.getHttpServer()).post('/refunds/00000000-0000-4000-8000-000000000000').expect(404);
    await request(app.getHttpServer()).post('/refunds/not-a-uuid').expect(400);
  });
});
