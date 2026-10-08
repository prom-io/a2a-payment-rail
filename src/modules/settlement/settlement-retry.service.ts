import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettlementStatus } from './entities/settlement.entity';
import { SettlementService } from './settlement.service';

export interface RetryRunResult {
  ran: boolean;
  attempted: number;
  settled: number;
  deadLettered: number;
}

/**
 * Drains the settlement retry queue.
 *
 * The queue is the `settlements` table itself: rows in `retrying` whose
 * `nextRetryAt` has passed. A row leaves the queue as `settled`, `rejected`
 * (the contract reverted) or `dead_letter` (attempts used up); the last two
 * only move again through POST /settlements/:id/replay.
 */
@Injectable()
export class SettlementRetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettlementRetryService.name);
  private readonly enabled: boolean;
  private readonly tickMs: number;
  private readonly batchSize: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly settlementService: SettlementService,
    configService: ConfigService,
  ) {
    this.enabled = configService.get<boolean>('settlement.retry.enabled', true);
    this.tickMs = configService.get<number>('settlement.retry.tickMs', 15_000);
    this.batchSize = configService.get<number>('settlement.retry.batchSize', 20);
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => {
      this.processDue().catch((error: Error) =>
        this.logger.error(`Settlement retry tick failed: ${error.message}`),
      );
    }, this.tickMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async processDue(now: Date = new Date()): Promise<RetryRunResult> {
    const result: RetryRunResult = { ran: false, attempted: 0, settled: 0, deadLettered: 0 };
    if (this.running) return result;
    this.running = true;
    try {
      result.ran = true;
      const due = await this.settlementService.findDueRetries(now, this.batchSize);
      // Strictly one at a time: every attempt is a transaction from the same
      // signer, and parallel sends would fight over the nonce.
      for (const settlement of due) {
        const updated = await this.settlementService.attempt(settlement, now);
        result.attempted += 1;
        if (updated.status === SettlementStatus.SETTLED) result.settled += 1;
        if (updated.status === SettlementStatus.DEAD_LETTER) {
          result.deadLettered += 1;
          this.logger.error(
            `Settlement ${updated.id} moved to dead letter after ${updated.attempts} attempts: ${updated.lastError}`,
          );
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
