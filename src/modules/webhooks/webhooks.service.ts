import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { WebhookDelivery, WebhookDeliveryStatus } from './entities/webhook-delivery.entity';
import { WebhookSubscription } from './entities/webhook-subscription.entity';
import { WebhookEnvelope, WebhookEvent } from './webhook-events';
import { buildSignatureHeader, SIGNATURE_HEADER } from './webhook-signature';
import { WebhookTransport } from './webhook-transport';

export type WebhookSubscriptionView = Omit<WebhookSubscription, 'secret'>;

const MAX_ERROR_LENGTH = 500;

/**
 * Webhook subscriptions and event fan-out.
 *
 * `emit()` is called from the escrow and settlement services after the state
 * change is committed. It never throws: a subscriber that is down must not be
 * able to fail an escrow or a settlement.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly timeoutMs: number;
  private readonly allowHttp: boolean;

  constructor(
    @InjectRepository(WebhookSubscription)
    private readonly subscriptions: Repository<WebhookSubscription>,
    @InjectRepository(WebhookDelivery)
    private readonly deliveries: Repository<WebhookDelivery>,
    private readonly transport: WebhookTransport,
    configService: ConfigService,
  ) {
    this.timeoutMs = configService.get<number>('webhooks.timeoutMs', 5_000);
    this.allowHttp = configService.get<boolean>('webhooks.allowHttp', true);
  }

  /** The only response that carries the secret. */
  async create(dto: CreateWebhookDto): Promise<WebhookSubscription> {
    if (!this.allowHttp && !dto.url.toLowerCase().startsWith('https://')) {
      throw new BadRequestException('Webhook url must use https');
    }
    return this.subscriptions.save(
      this.subscriptions.create({
        url: dto.url,
        events: dto.events,
        description: dto.description ?? null,
        secret: randomBytes(32).toString('hex'),
        active: true,
      }),
    );
  }

  async list(): Promise<WebhookSubscriptionView[]> {
    const rows = await this.subscriptions.find({ order: { createdAt: 'ASC' } });
    return rows.map(({ secret: _secret, ...view }) => view);
  }

  async remove(id: string): Promise<void> {
    const result = await this.subscriptions.delete({ id });
    if (!result.affected) throw new NotFoundException(`Webhook subscription ${id} not found`);
  }

  /** Replaces the secret. Deliveries sent from now on verify only against the new one. */
  async rotateSecret(id: string): Promise<WebhookSubscription> {
    const subscription = await this.subscriptions.findOne({ where: { id } });
    if (!subscription) throw new NotFoundException(`Webhook subscription ${id} not found`);
    subscription.secret = randomBytes(32).toString('hex');
    return this.subscriptions.save(subscription);
  }

  async listDeliveries(subscriptionId: string, limit = 50): Promise<WebhookDelivery[]> {
    return this.deliveries.find({
      where: { subscriptionId },
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  /** Records one delivery per interested subscription and sends it. */
  async emit(event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
    try {
      const active = await this.subscriptions.find({ where: { active: true } });
      const interested = active.filter((subscription) => subscription.events.includes(event));
      await Promise.all(
        interested.map(async (subscription) => {
          const delivery = await this.deliveries.save(
            this.deliveries.create({
              subscriptionId: subscription.id,
              event,
              payload: data,
              status: WebhookDeliveryStatus.PENDING,
              attempts: 0,
            }),
          );
          await this.deliver(delivery, subscription);
        }),
      );
    } catch (error) {
      this.logger.error(`Webhook fan-out for ${event} failed: ${(error as Error).message}`);
    }
  }

  /** One HTTP attempt; the outcome is written to the delivery row. */
  async deliver(
    delivery: WebhookDelivery,
    subscription: WebhookSubscription,
  ): Promise<WebhookDelivery> {
    const envelope: WebhookEnvelope = {
      id: delivery.id,
      event: delivery.event,
      createdAt: new Date(delivery.createdAt ?? Date.now()).toISOString(),
      data: delivery.payload,
    };
    const body = JSON.stringify(envelope);

    delivery.attempts += 1;
    try {
      const response = await this.transport.post(
        subscription.url,
        body,
        this.buildHeaders(delivery, subscription, body),
        this.timeoutMs,
      );
      delivery.responseStatus = response.status;
      if (response.status >= 200 && response.status < 300) {
        delivery.status = WebhookDeliveryStatus.DELIVERED;
        delivery.deliveredAt = new Date();
        delivery.lastError = null;
      } else {
        delivery.status = WebhookDeliveryStatus.FAILED;
        delivery.lastError = `subscriber answered ${response.status}`;
      }
    } catch (error) {
      delivery.status = WebhookDeliveryStatus.FAILED;
      delivery.responseStatus = null;
      delivery.lastError = String((error as Error).message ?? error).slice(0, MAX_ERROR_LENGTH);
    }
    if (delivery.status === WebhookDeliveryStatus.FAILED) {
      this.logger.warn(
        `Webhook ${delivery.event} to subscription ${subscription.id} failed ` +
          `(attempt ${delivery.attempts}): ${delivery.lastError}`,
      );
    }
    return this.deliveries.save(delivery);
  }

  // Signed at send time, so every redelivery carries a fresh timestamp and a
  // receiver's tolerance window applies to the attempt, not to the event.
  private buildHeaders(
    delivery: WebhookDelivery,
    subscription: WebhookSubscription,
    body: string,
  ): Record<string, string> {
    return {
      [SIGNATURE_HEADER]: buildSignatureHeader(subscription.secret, body),
      'Content-Type': 'application/json',
      'User-Agent': 'a2a-payment-rail-webhooks/1',
      'X-Prom-Event': delivery.event,
      'X-Prom-Delivery': delivery.id,
    };
  }
}
