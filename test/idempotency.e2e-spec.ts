import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Idempotency keys (e2e)', () => {
  let app: INestApplication;

  const escrowBody = {
    agentA: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    agentB: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    depositAmount: 1.0,
    budgetLimit: 1.0,
    ttl: 3600,
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

  it('opens one escrow for two requests with the same key', async () => {
    const key = randomUUID();

    const first = await request(app.getHttpServer())
      .post('/escrow')
      .set('Idempotency-Key', key)
      .send(escrowBody)
      .expect(201);
    const retry = await request(app.getHttpServer())
      .post('/escrow')
      .set('Idempotency-Key', key)
      .send(escrowBody)
      .expect(201);

    expect(retry.body.id).toBe(first.body.id);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    expect(retry.headers['idempotency-replayed']).toBe('true');
  });

  it('opens separate escrows for different keys', async () => {
    const a = await request(app.getHttpServer())
      .post('/escrow')
      .set('Idempotency-Key', randomUUID())
      .send(escrowBody)
      .expect(201);
    const b = await request(app.getHttpServer())
      .post('/escrow')
      .set('Idempotency-Key', randomUUID())
      .send(escrowBody)
      .expect(201);

    expect(a.body.id).not.toBe(b.body.id);
  });

  it('rejects a reused key with a different body', async () => {
    const key = randomUUID();
    await request(app.getHttpServer())
      .post('/escrow')
      .set('Idempotency-Key', key)
      .send(escrowBody)
      .expect(201);

    await request(app.getHttpServer())
      .post('/escrow')
      .set('Idempotency-Key', key)
      .send({ ...escrowBody, ttl: 7200 })
      .expect(422);
  });

  it('does not store a key for a request that failed validation', async () => {
    const key = randomUUID();
    await request(app.getHttpServer())
      .post('/escrow')
      .set('Idempotency-Key', key)
      .send({ agentA: '0xabc' })
      .expect(400);

    // the failed attempt released the key, so it can carry the corrected request
    await request(app.getHttpServer())
      .post('/escrow')
      .set('Idempotency-Key', key)
      .send(escrowBody)
      .expect(201);
  });
});
