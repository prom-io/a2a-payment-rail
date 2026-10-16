import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { LessThanOrEqual, Repository } from 'typeorm';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { WebhookDelivery, WebhookDeliveryStatus } from './entities/webhook-delivery.entity';
import { WebhookSubscription } from './entities/webhook-subscription.entity';
import { WebhookEnvelope, WebhookEvent } from './webhook-events';
import { buildSignatureHeader, SIGNATURE_HEADER } from './webhook-signature';
import { WebhookTransport } from './webhook-transport';

export type WebhookSubscriptionView = Omit<WebhookSubscription, 'secret'>;

const MAX_ERROR_LENGTH = 500;
const HTTP_GONE = 410;

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
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

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
    this.maxAttempts = configService.get<number>('webhooks.retry.maxAttempts', 6);
    this.baseDelayMs = configService.get<number>('webhooks.retry.baseDelayMs', 10_000);
    this.maxDelayMs = configService.get<number>('webhooks.retry.maxDelayMs', 3_600_000);
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
  async emit(
    event: WebhookEvent,
    data: Record<string, unknown>,
    now: Date = new Date(),
  ): Promise<void> {
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
          await this.deliver(delivery, subscription, now);
        }),
      );
    } catch (error) {
      this.logger.error(`Webhook fan-out for ${event} failed: ${(error as Error).message}`);
    }
  }

  /** Failed deliveries whose next attempt is due, oldest first. */
  async findDueDeliveries(now: Date, limit: number): Promise<WebhookDelivery[]> {
    return this.deliveries.find({
      where: { status: WebhookDeliveryStatus.FAILED, nextAttemptAt: LessThanOrEqual(now) },
      order: { nextAttemptAt: 'ASC' },
      take: limit,
    });
  }

  /** Next attempt of a failed delivery; gives up if its subscription is gone or paused. */
  async redeliver(delivery: WebhookDelivery, now: Date = new Date()): Promise<WebhookDelivery> {
    const subscription = await this.subscriptions.findOne({ where: { id: delivery.subscriptionId } });
    if (!subscription || !subscription.active) {
      delivery.status = WebhookDeliveryStatus.EXHAUSTED;
      delivery.nextAttemptAt = null;
      delivery.lastError = 'subscription is no longer active';
      return this.deliveries.save(delivery);
    }
    return this.deliver(delivery, subscription, now);
  }

  /** Delay before the next attempt: base, 2x base, 4x base ... capped at maxDelayMs. */
  backoffMs(attempts: number): number {
    const exponent = Math.min(Math.max(attempts - 1, 0), 30);
    return Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
  }

  /**
   * One HTTP attempt; the outcome is written to the delivery row.
   *
   *   2xx                 -> delivered
   *   410 Gone            -> exhausted, and the subscription is paused
   *   anything else       -> failed, retried after backoffMs(attempts);
   *                          exhausted once maxAttempts is reached
   */
  async deliver(
    delivery: WebhookDelivery,
    subscription: WebhookSubscription,
    now: Date = new Date(),
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
        delivery.deliveredAt = now;
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
    delivery.nextAttemptAt = null;
    if (delivery.status === WebhookDeliveryStatus.FAILED) {
      if (delivery.responseStatus === HTTP_GONE) {
        // The subscriber says the endpoint is gone for good: stop sending to it.
        delivery.status = WebhookDeliveryStatus.EXHAUSTED;
        subscription.active = false;
        await this.subscriptions.save(subscription);
      } else if (delivery.attempts >= this.maxAttempts) {
        delivery.status = WebhookDeliveryStatus.EXHAUSTED;
      } else {
        delivery.nextAttemptAt = new Date(now.getTime() + this.backoffMs(delivery.attempts));
      }
      this.logger.warn(
        `Webhook ${delivery.event} to subscription ${subscription.id} failed ` +
          `(attempt ${delivery.attempts}/${this.maxAttempts}, now ${delivery.status}): ${delivery.lastError}`,
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
