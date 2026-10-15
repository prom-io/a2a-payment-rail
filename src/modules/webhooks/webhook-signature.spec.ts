import { NotFoundException } from '@nestjs/common';
import { webhookHarness } from '../../testing/webhook-fixtures';
import { WebhookEvent } from './webhook-events';
import {
  buildSignatureHeader,
  computeSignature,
  verifySignatureHeader,
} from './webhook-signature';

const SECRET = 'a'.repeat(64);
const BODY = '{"id":"d1","event":"escrow.opened","data":{"escrowId":"e1"}}';
const NOW = new Date('2026-06-01T12:00:00.000Z');
const T = Math.floor(NOW.getTime() / 1000);

describe('webhook signatures', () => {
  it('signs "<timestamp>.<body>" with hmac-sha256', () => {
    // Known answer, computed independently with openssl:
    //   printf '1.x' | openssl dgst -sha256 -hmac key
    expect(computeSignature('key', 1, 'x')).toBe(
      'fc4913c41a7bf793267e2a384f3261c9436ec2cd097bd745e7b0d99113f510ec',
    );
    expect(buildSignatureHeader(SECRET, BODY, NOW)).toBe(`t=${T},v1=${computeSignature(SECRET, T, BODY)}`);
  });

  it('accepts a fresh signature', () => {
    const header = buildSignatureHeader(SECRET, BODY, NOW);
    expect(verifySignatureHeader({ secret: SECRET, header, body: BODY, now: NOW })).toEqual({
      valid: true,
      timestamp: T,
    });
  });

  it('rejects a changed body, a changed timestamp and a wrong secret', () => {
    const header = buildSignatureHeader(SECRET, BODY, NOW);
    const check = (overrides: Partial<Parameters<typeof verifySignatureHeader>[0]>) =>
      verifySignatureHeader({ secret: SECRET, header, body: BODY, now: NOW, ...overrides });

    expect(check({ body: BODY.replace('e1', 'e2') }).reason).toBe('signature_mismatch');
    expect(check({ secret: 'b'.repeat(64) }).reason).toBe('signature_mismatch');
    // moving the timestamp forward to dodge the tolerance breaks the hmac
    expect(check({ header: header.replace(`t=${T}`, `t=${T + 60}`) }).reason).toBe('signature_mismatch');
  });

  it('rejects a replay outside the tolerance window, in both directions', () => {
    const header = buildSignatureHeader(SECRET, BODY, NOW);
    const at = (offsetSeconds: number) =>
      verifySignatureHeader({
        secret: SECRET,
        header,
        body: BODY,
        toleranceSeconds: 300,
        now: new Date(NOW.getTime() + offsetSeconds * 1000),
      });

    expect(at(300).valid).toBe(true);
    expect(at(301)).toMatchObject({ valid: false, reason: 'timestamp_out_of_tolerance' });
    expect(at(-300).valid).toBe(true);
    expect(at(-301)).toMatchObject({ valid: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('accepts any of several v1 signatures, for secret rotation', () => {
    const old = computeSignature('old-secret', T, BODY);
    const header = `t=${T},v1=${old},v1=${computeSignature(SECRET, T, BODY)},v2=ignored`;
    expect(verifySignatureHeader({ secret: SECRET, header, body: BODY, now: NOW }).valid).toBe(true);
  });

  it.each([
    undefined,
    '',
    'garbage',
    `v1=${'0'.repeat(64)}`,
    `t=${T}`,
    `t=abc,v1=${'0'.repeat(64)}`,
    `t=${T},v1=tooshort`,
    `t=${T},v1=${'Z'.repeat(64)}`,
  ])('treats %p as a malformed header', (header) => {
    expect(verifySignatureHeader({ secret: SECRET, header, body: BODY, now: NOW })).toEqual({
      valid: false,
      reason: 'malformed_header',
    });
  });
});

describe('signed deliveries', () => {
  it('signs every delivery with the secret of its subscription', async () => {
    const { service, sent } = webhookHarness();
    const a = await service.create({ url: 'https://a.example/h', events: [WebhookEvent.ESCROW_OPENED] });
    const b = await service.create({ url: 'https://b.example/h', events: [WebhookEvent.ESCROW_OPENED] });

    await service.emit(WebhookEvent.ESCROW_OPENED, { escrowId: 'e1' });

    expect(sent).toHaveLength(2);
    for (const request of sent) {
      const own = request.url.includes('a.example') ? a : b;
      const other = own === a ? b : a;
      const header = request.headers['X-Prom-Signature'];
      expect(verifySignatureHeader({ secret: own.secret, header, body: request.body }).valid).toBe(true);
      expect(verifySignatureHeader({ secret: other.secret, header, body: request.body }).valid).toBe(false);
    }
  });

  it('rotates a secret: old signatures stop verifying, the new secret is returned once', async () => {
    const { service, sent } = webhookHarness();
    const created = await service.create({ url: 'https://a.example/h', events: [WebhookEvent.ESCROW_CLOSED] });
    const oldSecret = created.secret;

    const rotated = await service.rotateSecret(created.id);
    await service.emit(WebhookEvent.ESCROW_CLOSED, {});

    expect(rotated.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated.secret).not.toBe(oldSecret);
    const { headers, body } = sent[0];
    expect(verifySignatureHeader({ secret: rotated.secret, header: headers['X-Prom-Signature'], body }).valid).toBe(true);
    expect(verifySignatureHeader({ secret: oldSecret, header: headers['X-Prom-Signature'], body }).valid).toBe(false);
    await expect(service.rotateSecret('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
