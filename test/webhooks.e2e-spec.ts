import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { WebhookRetryService } from '../src/modules/webhooks/webhook-retry.service';
import { verifySignatureHeader } from '../src/modules/webhooks/webhook-signature';

interface Received {
  headers: IncomingMessage['headers'];
  body: string;
}

describe('Webhooks (e2e)', () => {
  let app: INestApplication;
  let receiver: Server;
  let receiverUrl: string;
  let adminToken: string;
  let agentToken: string;
  let subscription: { id: string; secret: string };
  // Status codes the receiver answers with, in order; 200 once the list is empty.
  let scriptedStatuses: number[] = [];
  const received: Received[] = [];
  let waiters: Array<() => void> = [];

  /** Resolves once the receiver has seen `count` requests in total. */
  const receivedCount = (count: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`receiver saw ${received.length}/${count}`)), 4_000);
      const check = () => {
        if (received.length < count) return;
        clearTimeout(timer);
        resolve();
      };
      waiters.push(check);
      check();
    });

  const openEscrow = () =>
    request(app.getHttpServer())
      .post('/escrow')
      .send({
        agentA: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        agentB: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        depositAmount: 1.0,
        budgetLimit: 1.0,
        ttl: 3600,
      })
      .expect(201);

  const deliveries = async () => {
    const res = await request(app.getHttpServer())
      .get(`/webhooks/${subscription.id}/deliveries`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    return res.body as Array<Record<string, any>>;
  };

  beforeAll(async () => {
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(scriptedStatuses.shift() ?? 200).end();
        waiters.forEach((check) => check());
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const jwt = app.get(JwtService);
    adminToken = jwt.sign({ sub: 'ops-1', address: '0x0', role: 'admin' });
    agentToken = jwt.sign({ sub: 'agent-1', address: '0x0', role: 'agent' });
  });

  afterAll(async () => {
    // Leave no subscription behind: later suites would keep posting to a dead port.
    if (subscription) {
      await request(app.getHttpServer())
        .delete(`/webhooks/${subscription.id}`)
        .set('Authorization', `Bearer ${adminToken}`);
    }
    await app.close();
    await new Promise((resolve) => receiver.close(resolve));
  });

  beforeEach(() => {
    waiters = [];
  });

  it('only lets admin and service roles manage subscriptions', async () => {
    const body = { url: receiverUrl, events: ['escrow.opened'] };
    await request(app.getHttpServer()).post('/webhooks').send(body).expect(401);
    await request(app.getHttpServer())
      .post('/webhooks')
      .set('Authorization', `Bearer ${agentToken}`)
      .send(body)
      .expect(403);
    await request(app.getHttpServer()).get('/webhooks').expect(401);
  });

  it('rejects unknown events and non-http urls', async () => {
    const post = (body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body);

    await post({ url: receiverUrl, events: ['escrow.exploded'] }).expect(400);
    await post({ url: receiverUrl, events: [] }).expect(400);
    await post({ url: 'ftp://example.com/hook', events: ['escrow.opened'] }).expect(400);
  });

  it('creates a subscription, returns the secret once and hides it afterwards', async () => {
    const created = await request(app.getHttpServer())
      .post('/webhooks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ url: receiverUrl, events: ['escrow.opened'], description: 'e2e receiver' })
      .expect(201);
    expect(created.body.secret).toMatch(/^[0-9a-f]{64}$/);
    subscription = created.body;

    const listed = await request(app.getHttpServer())
      .get('/webhooks')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const own = listed.body.find((row: { id: string }) => row.id === subscription.id);
    expect(own).toMatchObject({ url: receiverUrl, events: ['escrow.opened'], active: true });
    expect(own.secret).toBeUndefined();
  });

  it('delivers a signed escrow.opened event when an escrow is opened', async () => {
    const escrow = await openEscrow();
    await receivedCount(1);

    const { headers, body } = received[0];
    const envelope = JSON.parse(body);
    expect(envelope).toMatchObject({ event: 'escrow.opened', data: { escrowId: escrow.body.id } });
    expect(headers['x-prom-event']).toBe('escrow.opened');
    expect(headers['x-prom-delivery']).toBe(envelope.id);

    const header = headers['x-prom-signature'] as string;
    expect(verifySignatureHeader({ secret: subscription.secret, header, body }).valid).toBe(true);
    expect(verifySignatureHeader({ secret: 'wrong', header, body }).reason).toBe('signature_mismatch');
    expect(
      verifySignatureHeader({ secret: subscription.secret, header, body: body.replace(escrow.body.id, 'x') }).valid,
    ).toBe(false);
    // the same capture replayed an hour later is refused
    expect(
      verifySignatureHeader({
        secret: subscription.secret,
        header,
        body,
        now: new Date(Date.now() + 3_600_000),
      }).reason,
    ).toBe('timestamp_out_of_tolerance');
  });

  it('does not deliver events the subscription did not ask for', async () => {
    const escrow = await openEscrow();
    await receivedCount(2);
    await request(app.getHttpServer()).post(`/escrow/${escrow.body.id}/close`).expect(200);

    // escrow.closed is not subscribed: the receiver must still have seen two requests only
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received).toHaveLength(2);
  });

  it('retries a failed delivery with the same id and records the outcome', async () => {
    scriptedStatuses = [500];
    await openEscrow();
    await receivedCount(3);

    // the failed row is written right after the receiver answered
    let failed: Record<string, any> | undefined;
    for (let i = 0; i < 20 && !failed; i += 1) {
      failed = (await deliveries()).find((d) => d.status === 'failed');
      if (!failed) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(failed).toMatchObject({ attempts: 1, responseStatus: 500 });
    expect(failed!.nextAttemptAt).toBeTruthy();

    const result = await app.get(WebhookRetryService).processDue(new Date(Date.now() + 3_600_000));
    expect(result.delivered).toBeGreaterThanOrEqual(1);
    await receivedCount(4);

    const firstAttempt = JSON.parse(received[2].body);
    const secondAttempt = JSON.parse(received[3].body);
    expect(secondAttempt.id).toBe(firstAttempt.id);
    expect(
      verifySignatureHeader({
        secret: subscription.secret,
        header: received[3].headers['x-prom-signature'] as string,
        body: received[3].body,
      }).valid,
    ).toBe(true);

    const after = (await deliveries()).find((d) => d.id === failed!.id);
    expect(after).toMatchObject({ status: 'delivered', attempts: 2, responseStatus: 200 });
  });

  it('signs with the new secret after a rotation', async () => {
    const rotated = await request(app.getHttpServer())
      .post(`/webhooks/${subscription.id}/rotate-secret`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const oldSecret = subscription.secret;
    subscription = rotated.body;
    expect(subscription.secret).not.toBe(oldSecret);

    await openEscrow();
    await receivedCount(5);

    const { headers, body } = received[4];
    const header = headers['x-prom-signature'] as string;
    expect(verifySignatureHeader({ secret: subscription.secret, header, body }).valid).toBe(true);
    expect(verifySignatureHeader({ secret: oldSecret, header, body }).valid).toBe(false);
  });
});
