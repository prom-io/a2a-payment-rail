import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { buildSignatureHeader, verifySignatureHeader } from './webhook-signature';
import { WebhookTransport } from './webhook-transport';

/**
 * The transport against a real HTTP server on the loopback interface: what
 * the subscriber receives is exactly what was signed.
 */

interface Received {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
}

describe('WebhookTransport', () => {
  const transport = new WebhookTransport();
  let server: Server;
  let baseUrl: string;
  let received: Received[];
  let respond: (req: IncomingMessage, res: ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        respond(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    received = [];
    respond = (_req, res) => res.writeHead(204).end();
  });

  it('posts the body byte for byte with the given headers', async () => {
    const body = JSON.stringify({ id: 'd1', data: { note: 'unicode é中 and "quotes"' } });

    const response = await transport.post(
      `${baseUrl}/hook?tenant=7`,
      body,
      { 'Content-Type': 'application/json', 'X-Prom-Event': 'escrow.opened' },
      2_000,
    );

    expect(response.status).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: 'POST', url: '/hook?tenant=7', body });
    expect(received[0].headers['content-type']).toBe('application/json');
    expect(received[0].headers['x-prom-event']).toBe('escrow.opened');
  });

  it('delivers a signature the receiver can verify from the raw body', async () => {
    const secret = 'f'.repeat(64);
    const body = JSON.stringify({ id: 'd2', event: 'settlement.settled', data: { totalAmount: '1.5' } });

    await transport.post(baseUrl, body, { 'X-Prom-Signature': buildSignatureHeader(secret, body) }, 2_000);

    const header = received[0].headers['x-prom-signature'] as string;
    expect(verifySignatureHeader({ secret, header, body: received[0].body }).valid).toBe(true);
    // parsing and re-serialising with different spacing is not the signed payload
    const reformatted = JSON.stringify(JSON.parse(received[0].body), null, 2);
    expect(verifySignatureHeader({ secret, header, body: reformatted }).reason).toBe('signature_mismatch');
  });

  it.each([200, 201, 400, 410, 500, 503])('reports status %i without throwing', async (status) => {
    respond = (_req, res) => res.writeHead(status).end('ignored body');

    await expect(transport.post(baseUrl, '{}', {}, 2_000)).resolves.toEqual({ status });
  });

  it('does not follow redirects', async () => {
    respond = (req, res) => {
      if (req.url === '/moved') res.writeHead(200).end();
      else res.writeHead(302, { Location: `${baseUrl}/moved` }).end();
    };

    const response = await transport.post(`${baseUrl}/hook`, '{}', {}, 2_000);

    expect(response.status).toBe(302);
    expect(received.map((r) => r.url)).toEqual(['/hook']);
  });

  it('gives up on a subscriber that does not answer within the timeout', async () => {
    const pending: ServerResponse[] = [];
    respond = (_req, res) => pending.push(res);

    await expect(transport.post(baseUrl, '{}', {}, 150)).rejects.toThrow(/timeout|aborted/i);
    pending.forEach((res) => res.end());
  });

  it('rejects when nothing listens on the port', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));

    await expect(transport.post(`http://127.0.0.1:${port}`, '{}', {}, 1_000)).rejects.toThrow();
  });
});
