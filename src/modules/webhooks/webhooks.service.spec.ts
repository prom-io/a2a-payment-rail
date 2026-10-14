import { BadRequestException, NotFoundException } from '@nestjs/common';
import { webhookHarness } from '../../testing/webhook-fixtures';
import { WebhookDeliveryStatus } from './entities/webhook-delivery.entity';
import { WebhookEvent } from './webhook-events';

const URL = 'https://agent.example/hooks';

describe('WebhooksService', () => {
  it('creates a subscription with a random secret and hides it from listings', async () => {
    const { service } = webhookHarness();

    const a = await service.create({ url: URL, events: [WebhookEvent.ESCROW_OPENED] });
    const b = await service.create({ url: URL, events: [WebhookEvent.ESCROW_CLOSED] });

    expect(a.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(a.secret).not.toBe(b.secret);
    const listed = await service.list();
    expect(listed).toHaveLength(2);
    expect(listed.every((row) => !('secret' in row))).toBe(true);
  });

  it('requires https unless plain http is allowed', async () => {
    const strict = webhookHarness({ 'webhooks.allowHttp': false }).service;
    const lax = webhookHarness({ 'webhooks.allowHttp': true }).service;
    const dto = { url: 'http://localhost:9000/hook', events: [WebhookEvent.ESCROW_OPENED] };

    await expect(strict.create(dto)).rejects.toBeInstanceOf(BadRequestException);
    await expect(lax.create(dto)).resolves.toMatchObject({ url: dto.url });
  });

  it('delivers an event only to the subscriptions that asked for it', async () => {
    const { service, sent, deliveries } = webhookHarness();
    const wanted = await service.create({ url: `${URL}/a`, events: [WebhookEvent.SETTLEMENT_SETTLED] });
    await service.create({ url: `${URL}/b`, events: [WebhookEvent.ESCROW_OPENED] });

    await service.emit(WebhookEvent.SETTLEMENT_SETTLED, { settlementId: 's1', totalAmount: '1.5' });

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${URL}/a`);
    expect(JSON.parse(sent[0].body)).toMatchObject({
      id: deliveries[0].id,
      event: 'settlement.settled',
      data: { settlementId: 's1', totalAmount: '1.5' },
    });
    expect(sent[0].headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Prom-Event': 'settlement.settled',
      'X-Prom-Delivery': deliveries[0].id,
    });
    expect(deliveries[0]).toMatchObject({
      subscriptionId: wanted.id,
      status: WebhookDeliveryStatus.DELIVERED,
      attempts: 1,
      responseStatus: 200,
    });
  });

  it('skips inactive and removed subscriptions', async () => {
    const { service, sent, subscriptions } = webhookHarness();
    const paused = await service.create({ url: `${URL}/paused`, events: [WebhookEvent.ESCROW_OPENED] });
    const removed = await service.create({ url: `${URL}/gone`, events: [WebhookEvent.ESCROW_OPENED] });
    subscriptions.find((s) => s.id === paused.id)!.active = false;
    await service.remove(removed.id);

    await service.emit(WebhookEvent.ESCROW_OPENED, { escrowId: 'e1' });

    expect(sent).toHaveLength(0);
    await expect(service.remove(removed.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('records a non-2xx answer as a failed delivery', async () => {
    const { service, transport, deliveries } = webhookHarness();
    await service.create({ url: URL, events: [WebhookEvent.ESCROW_CLOSED] });
    transport.post.mockResolvedValueOnce({ status: 503 });

    await service.emit(WebhookEvent.ESCROW_CLOSED, { escrowId: 'e1' });

    expect(deliveries[0]).toMatchObject({
      status: WebhookDeliveryStatus.FAILED,
      responseStatus: 503,
      lastError: 'subscriber answered 503',
    });
  });

  it('never lets a broken subscriber or a broken database fail the caller', async () => {
    const { service, transport, deliveries, subscriptionRepo } = webhookHarness();
    await service.create({ url: URL, events: [WebhookEvent.ESCROW_OPENED] });
    transport.post.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await expect(service.emit(WebhookEvent.ESCROW_OPENED, {})).resolves.toBeUndefined();
    expect(deliveries[0]).toMatchObject({
      status: WebhookDeliveryStatus.FAILED,
      responseStatus: null,
      lastError: 'connect ECONNREFUSED',
    });

    subscriptionRepo.find.mockRejectedValueOnce(new Error('database is gone'));
    await expect(service.emit(WebhookEvent.ESCROW_OPENED, {})).resolves.toBeUndefined();
  });

  it('lists the deliveries of one subscription', async () => {
    const { service } = webhookHarness();
    const a = await service.create({ url: `${URL}/a`, events: [WebhookEvent.ESCROW_OPENED] });
    await service.create({ url: `${URL}/b`, events: [WebhookEvent.ESCROW_OPENED] });

    await service.emit(WebhookEvent.ESCROW_OPENED, {});

    const listed = await service.listDeliveries(a.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].subscriptionId).toBe(a.id);
  });
});
