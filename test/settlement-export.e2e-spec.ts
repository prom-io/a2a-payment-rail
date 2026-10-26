import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Settlement export (e2e)', () => {
  let app: INestApplication;
  let token: string;
  const escrowId = randomUUID();
  const created: string[] = [];

  const exportPage = (query: Record<string, string | number>) =>
    request(app.getHttpServer())
      .get('/settlements/export')
      .set('Authorization', `Bearer ${token}`)
      .query({ escrowId, ...query });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    token = app.get(JwtService).sign({ sub: 'ops-1', address: '0x0', role: 'admin' });

    // Seven settlements written back to back, so some share a millisecond.
    for (let i = 1; i <= 7; i += 1) {
      const res = await request(app.getHttpServer())
        .post('/settlements/batch')
        .send({ escrowId, receiptsHash: '0x' + i.toString(16).padStart(64, '0'), totalAmount: i })
        .expect(201);
      created.push(res.body.id);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires an admin or service token', async () => {
    await request(app.getHttpServer()).get('/settlements/export').expect(401);
    const agent = app.get(JwtService).sign({ sub: 'a', address: '0x0', role: 'agent' });
    await request(app.getHttpServer())
      .get('/settlements/export')
      .set('Authorization', `Bearer ${agent}`)
      .expect(403);
  });

  it('exports csv with a header and one line per settlement', async () => {
    const res = await exportPage({ format: 'csv' }).expect(200);

    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toContain('settlements.csv');
    expect(res.headers['x-next-cursor']).toBeUndefined();
    const lines = res.text.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe(
      'id,escrowId,status,totalAmount,feeAmount,receiptsHash,receiptCount,attempts,txHash,createdAt,settledAt',
    );
    expect(lines).toHaveLength(8);
    expect(lines.slice(1).map((line) => line.split(',')[0]).sort()).toEqual([...created].sort());
  });

  it('pages through ndjson with the cursor and returns every row exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await exportPage({ format: 'ndjson', limit: 3, ...(cursor ? { cursor } : {}) }).expect(200);
      expect(res.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
      const rows = res.text.trimEnd().split('\n').map((line) => JSON.parse(line));
      expect(rows.length).toBeLessThanOrEqual(3);
      seen.push(...rows.map((row) => row.id));
      cursor = res.headers['x-next-cursor'];
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect([...seen].sort()).toEqual([...created].sort());
  });

  it('returns rows oldest first', async () => {
    const res = await exportPage({ format: 'ndjson' }).expect(200);
    const times = res.text.trimEnd().split('\n').map((line) => JSON.parse(line).createdAt);
    expect([...times].sort()).toEqual(times);
  });

  it('filters by status', async () => {
    const res = await exportPage({ format: 'ndjson', status: 'dead_letter' }).expect(200);
    expect(res.text).toBe('');
  });

  it('rejects bad parameters', async () => {
    // The short throttler allows 10 calls per second per route; let the window pass.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await exportPage({ format: 'xlsx' }).expect(400);
    await exportPage({ limit: 0 }).expect(400);
    await exportPage({ cursor: 'forged' }).expect(400);
    await exportPage({ from: 'yesterday' }).expect(400);
  });
});
