import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Payment Rail (e2e)', () => {
  let app: INestApplication;
  let escrowId: string;

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

  describe('/health (GET)', () => {
    it('should return ok', () => {
      return request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('ok');
          expect(res.body.service).toBe('a2a-payment-rail');
        });
    });
  });

  describe('/escrow (POST)', () => {
    it('should open an escrow session', () => {
      return request(app.getHttpServer())
        .post('/escrow')
        .send({
          agentA: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          agentB: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          depositAmount: 1.0,
          budgetLimit: 1.0,
          verificationRequired: true,
          ttl: 3600,
        })
        .expect(201)
        .expect((res) => {
          expect(res.body.id).toBeDefined();
          expect(res.body.status).toBeDefined();
          escrowId = res.body.id;
        });
    });

    it('should reject invalid escrow body', () => {
      return request(app.getHttpServer())
        .post('/escrow')
        .send({ agentA: '0xabc' })
        .expect(400);
    });
  });

  describe('/escrow/:id (GET)', () => {
    it('should return the created escrow', async () => {
      if (!escrowId) return;
      return request(app.getHttpServer())
        .get(`/escrow/${escrowId}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.id).toBe(escrowId);
        });
    });

    it('should return 404 for non-existent escrow', () => {
      return request(app.getHttpServer())
        .get('/escrow/00000000-0000-0000-0000-000000000000')
        .expect(404);
    });
  });

  describe('/escrow/:id/close (POST)', () => {
    it('should close the escrow', async () => {
      if (!escrowId) return;
      return request(app.getHttpServer())
        .post(`/escrow/${escrowId}/close`)
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('closed');
        });
    });
  });
});
