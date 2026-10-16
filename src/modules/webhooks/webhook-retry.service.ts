import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookDeliveryStatus } from './entities/webhook-delivery.entity';
import { WebhooksService } from './webhooks.service';

export interface WebhookRetryRunResult {
  ran: boolean;
  attempted: number;
  delivered: number;
  exhausted: number;
}

/**
 * Redelivers failed webhooks.
 *
 * The queue is `webhook_deliveries` itself: rows in `failed` whose
 * `nextAttemptAt` has passed. WebhooksService.deliver() decides what happens
 * to a row after each attempt; this class only finds the due ones and keeps
 * two ticks from working on the same rows.
 */
@Injectable()
export class WebhookRetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookRetryService.name);
  private readonly enabled: boolean;
  private readonly tickMs: number;
  private readonly batchSize: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly webhooksService: WebhooksService,
    configService: ConfigService,
  ) {
    this.enabled = configService.get<boolean>('webhooks.retry.enabled', true);
    this.tickMs = configService.get<number>('webhooks.retry.tickMs', 10_000);
    this.batchSize = configService.get<number>('webhooks.retry.batchSize', 50);
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => {
      this.processDue().catch((error: Error) =>
        this.logger.error(`Webhook retry tick failed: ${error.message}`),
      );
    }, this.tickMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async processDue(now: Date = new Date()): Promise<WebhookRetryRunResult> {
    const result: WebhookRetryRunResult = { ran: false, attempted: 0, delivered: 0, exhausted: 0 };
    if (this.running) return result;
    this.running = true;
    try {
      result.ran = true;
      const due = await this.webhooksService.findDueDeliveries(now, this.batchSize);
      for (const delivery of due) {
        const updated = await this.webhooksService.redeliver(delivery, now);
        result.attempted += 1;
        if (updated.status === WebhookDeliveryStatus.DELIVERED) result.delivered += 1;
        if (updated.status === WebhookDeliveryStatus.EXHAUSTED) result.exhausted += 1;
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
