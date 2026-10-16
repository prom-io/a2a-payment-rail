import { Repository } from 'typeorm';
import { WebhookDelivery } from '../modules/webhooks/entities/webhook-delivery.entity';
import { WebhookSubscription } from '../modules/webhooks/entities/webhook-subscription.entity';
import { WebhookTransport } from '../modules/webhooks/webhook-transport';
import { WebhooksService } from '../modules/webhooks/webhooks.service';
import { configStub } from './stubs';

export interface SentWebhook {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** WebhooksService over in-memory tables and a scripted transport. */
export function webhookHarness(config: Record<string, unknown> = {}) {
  const subscriptions: WebhookSubscription[] = [];
  const deliveries: WebhookDelivery[] = [];
  const sent: SentWebhook[] = [];
  let seq = 0;

  const table = <T extends { id: string }>(rows: T[]) => ({
    create: (data: Partial<T>) => ({ createdAt: new Date(), ...data }) as unknown as T,
    save: jest.fn(async (row: T) => {
      if (!row.id) {
        row.id = `id-${(seq += 1)}`;
        rows.push(row);
      }
      return row;
    }),
    find: jest.fn(async (options: { where?: Record<string, unknown> } = {}) =>
      rows.filter((row) =>
        Object.entries(options.where ?? {}).every(([key, value]) => {
          const actual = (row as Record<string, unknown>)[key];
          // FindOperator from LessThanOrEqual(date): the only operator the service uses
          if (value && typeof value === 'object' && 'value' in value) {
            return actual instanceof Date && actual.getTime() <= (value.value as Date).getTime();
          }
          return actual === value;
        }),
      ),
    ),
    findOne: jest.fn(async (options: { where: { id: string } }) =>
      rows.find((row) => row.id === options.where.id) ?? null,
    ),
    delete: jest.fn(async ({ id }: { id: string }) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) rows.splice(index, 1);
      return { affected: index >= 0 ? 1 : 0 };
    }),
  });

  const transport = {
    post: jest.fn(async (url: string, body: string, headers: Record<string, string>) => {
      sent.push({ url, body, headers });
      return { status: 200 };
    }),
  };

  const subscriptionRepo = table(subscriptions);
  const deliveryRepo = table(deliveries);
  const service = new WebhooksService(
    subscriptionRepo as unknown as Repository<WebhookSubscription>,
    deliveryRepo as unknown as Repository<WebhookDelivery>,
    transport as unknown as WebhookTransport,
    configStub(config),
  );
  return { service, subscriptions, deliveries, sent, transport, deliveryRepo, subscriptionRepo };
}
