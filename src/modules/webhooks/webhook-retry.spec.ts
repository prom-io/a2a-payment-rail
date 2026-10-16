import { configStub } from '../../testing/stubs';
import { webhookHarness } from '../../testing/webhook-fixtures';
import { WebhookDeliveryStatus } from './entities/webhook-delivery.entity';
import { WebhookEvent } from './webhook-events';
import { WebhookRetryService } from './webhook-retry.service';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);
const RETRY = {
  'webhooks.retry.maxAttempts': 4,
  'webhooks.retry.baseDelayMs': 1_000,
  'webhooks.retry.maxDelayMs': 3_000,
};

async function failingDelivery(config: Record<string, unknown> = RETRY) {
  const harness = webhookHarness(config);
  const retry = new WebhookRetryService(harness.service, configStub(config));
  const subscription = await harness.service.create({
    url: 'https://agent.example/hook',
    events: [WebhookEvent.SETTLEMENT_SETTLED],
  });
  harness.transport.post.mockResolvedValueOnce({ status: 500 });
  await harness.service.emit(WebhookEvent.SETTLEMENT_SETTLED, { settlementId: 's1' }, NOW);
  return { ...harness, retry, subscription, delivery: harness.deliveries[0] };
}

describe('webhook delivery retries', () => {
  it('schedules the first retry one base delay after a failure', async () => {
    const { delivery } = await failingDelivery();

    expect(delivery).toMatchObject({ status: WebhookDeliveryStatus.FAILED, attempts: 1 });
    expect(delivery.nextAttemptAt).toEqual(later(1_000));
  });

  it('does not touch a delivery before it is due', async () => {
    const { retry, transport } = await failingDelivery();

    const result = await retry.processDue(later(999));

    expect(result).toMatchObject({ ran: true, attempted: 0 });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('redelivers with the same delivery id once the subscriber recovers', async () => {
    const { retry, delivery, sent } = await failingDelivery();

    const result = await retry.processDue(later(1_000));

    expect(result).toMatchObject({ attempted: 1, delivered: 1 });
    expect(delivery).toMatchObject({
      status: WebhookDeliveryStatus.DELIVERED,
      attempts: 2,
      nextAttemptAt: null,
      lastError: null,
    });
    expect(JSON.parse(sent[sent.length - 1].body).id).toBe(delivery.id);
    expect(sent[sent.length - 1].headers['X-Prom-Delivery']).toBe(delivery.id);
  });

  it('doubles the delay per attempt up to the cap, then gives up', async () => {
    const { retry, delivery, transport } = await failingDelivery();
    transport.post.mockResolvedValue({ status: 502 });

    const delays: number[] = [1_000];
    let clock = NOW;
    while (delivery.status === WebhookDeliveryStatus.FAILED) {
      clock = delivery.nextAttemptAt!;
      await retry.processDue(clock);
      if (delivery.nextAttemptAt) delays.push(delivery.nextAttemptAt.getTime() - clock.getTime());
    }

    expect(delays).toEqual([1_000, 2_000, 3_000]);
    expect(delivery).toMatchObject({
      status: WebhookDeliveryStatus.EXHAUSTED,
      attempts: 4,
      nextAttemptAt: null,
    });
    // an exhausted delivery is never picked up again
    expect((await retry.processDue(later(10 * 60_000))).attempted).toBe(0);
  });

  it('retries transport errors the same way as error statuses', async () => {
    const { retry, delivery, transport } = await failingDelivery();
    transport.post.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));

    await retry.processDue(later(1_000));

    expect(delivery).toMatchObject({
      status: WebhookDeliveryStatus.FAILED,
      attempts: 2,
      responseStatus: null,
    });
    expect(delivery.nextAttemptAt).toEqual(later(1_000 + 2_000));
  });

  it('stops at once and pauses the subscription when the endpoint answers 410 Gone', async () => {
    const { retry, delivery, transport, subscription, subscriptions } = await failingDelivery();
    transport.post.mockResolvedValueOnce({ status: 410 });

    const result = await retry.processDue(later(1_000));

    expect(result.exhausted).toBe(1);
    expect(delivery).toMatchObject({ status: WebhookDeliveryStatus.EXHAUSTED, attempts: 2 });
    expect(subscriptions.find((s) => s.id === subscription.id)!.active).toBe(false);
  });

  it('gives up without sending when the subscription was removed or paused', async () => {
    const { retry, delivery, transport, subscription, service } = await failingDelivery();
    await service.remove(subscription.id);

    const result = await retry.processDue(later(1_000));

    expect(result).toMatchObject({ attempted: 1, exhausted: 1 });
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(delivery.lastError).toMatch(/no longer active/);
  });

  it('never runs two passes over the queue at the same time', async () => {
    const { retry, deliveryRepo } = await failingDelivery();
    let release: (rows: never[]) => void = () => undefined;
    deliveryRepo.find.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));

    const first = retry.processDue(later(1_000));
    const second = await retry.processDue(later(1_000));
    release([]);

    expect(second.ran).toBe(false);
    expect((await first).ran).toBe(true);
  });

  it('starts its timer by default and not when retries are disabled', () => {
    const spy = jest.spyOn(global, 'setInterval');
    const { service } = webhookHarness();

    const off = new WebhookRetryService(service, configStub({ 'webhooks.retry.enabled': false }));
    off.onModuleInit();
    expect(spy).not.toHaveBeenCalled();

    const on = new WebhookRetryService(service, configStub());
    on.onModuleInit();
    expect(spy).toHaveBeenCalledTimes(1);
    on.onModuleDestroy();
    spy.mockRestore();
  });
});
