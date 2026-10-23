import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Reconciliation (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    adminToken = app.get(JwtService).sign({ sub: 'ops-1', address: '0x0', role: 'admin' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('does not let an anonymous caller start a run', async () => {
    await request(app.getHttpServer()).post('/reconciliation/run').expect(401);
  });

  it('records a skipped run when no hub is configured', async () => {
    const res = await request(app.getHttpServer())
      .post('/reconciliation/run')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toMatchObject({ status: 'skipped', checked: 0, mismatches: 0, details: [] });
    expect(res.body.error).toMatch(/ESCROW_HUB_ADDRESS/);
    expect(res.body.finishedAt).toBeTruthy();
  });

  it('serves the latest run and the run history', async () => {
    const latest = await request(app.getHttpServer()).get('/reconciliation/latest').expect(200);
    expect(latest.body.status).toBe('skipped');

    const runs = await request(app.getHttpServer()).get('/reconciliation/runs').query({ limit: 1 }).expect(200);
    expect(runs.body).toHaveLength(1);
    expect(runs.body[0].id).toBe(latest.body.id);
  });

  it('exposes the reconciliation gauges', async () => {
    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.text).toContain('payment_rail_reconciliation_mismatches');
  });
});
