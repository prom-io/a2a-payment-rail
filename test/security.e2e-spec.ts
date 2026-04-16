import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { SanitizePipe } from '../src/common/pipes/sanitize.pipe';

describe('Security (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new SanitizePipe(),
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Security headers', () => {
    it('sets X-Content-Type-Options to nosniff', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('sets X-Frame-Options to DENY', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });

    it('removes X-Powered-By header', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('Input validation', () => {
    it('rejects invalid Ethereum address in escrow open', async () => {
      const res = await request(app.getHttpServer())
        .post('/escrow')
        .send({
          agentA: 'not-an-address',
          agentB: '0x0000000000000000000000000000000000000000',
          cap: '100',
          ttl: 3600,
          streaming: false,
        });
      expect(res.status).toBe(400);
    });

    it('rejects TTL outside allowed range', async () => {
      const res = await request(app.getHttpServer())
        .post('/escrow')
        .send({
          agentA: '0x0000000000000000000000000000000000000001',
          agentB: '0x0000000000000000000000000000000000000002',
          cap: '100',
          ttl: 10,
          streaming: false,
        });
      expect(res.status).toBe(400);
    });

    it('strips HTML tags from input fields', async () => {
      const res = await request(app.getHttpServer())
        .post('/escrow')
        .send({
          agentA: '0x0000000000000000000000000000000000000001',
          agentB: '<script>alert(1)</script>0x0000000000000000000000000000000000000002',
          cap: '100',
          ttl: 3600,
          streaming: false,
        });
      expect(res.status).toBe(400);
    });
  });

  describe('Rate limiting', () => {
    it('allows health endpoint through @SkipThrottle', async () => {
      const promises = Array.from({ length: 20 }, () =>
        request(app.getHttpServer()).get('/health'),
      );
      const results = await Promise.all(promises);
      results.forEach((r) => expect(r.status).toBe(200));
    });
  });
});
