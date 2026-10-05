import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { PaymentReceipt } from '../receipts/entities/payment-receipt.entity';
import { ReceiptsService } from '../receipts/receipts.service';
import { SettlementStatus } from './entities/settlement.entity';
import { calldataGas, packReceiptsCompact } from './batch-calldata.util';
import { SettlementService } from './settlement.service';

export interface BatchRunResult {
  /** False when the previous run was still in flight and this one was skipped. */
  ran: boolean;
  scanned: number;
  batches: number;
  receipts: number;
  failed: number;
}

const AMOUNT_DECIMALS = 18;

/**
 * Groups unsettled receipts per escrow and settles them in batches.
 *
 * An escrow is flushed when either bound is hit:
 *   - window: its oldest unsettled receipt has waited `windowMs`;
 *   - cap:    it has accumulated `maxReceipts` receipts (flushed early, full
 *             batches only, the remainder keeps waiting for the window).
 *
 * A receipt is attached to its settlement by `settlementId`, which is what
 * keeps it from being picked up by the next tick.
 */
@Injectable()
export class SettlementBatchScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettlementBatchScheduler.name);
  private readonly enabled: boolean;
  private readonly windowMs: number;
  private readonly maxReceipts: number;
  private readonly tickMs: number;
  private readonly scanLimit: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly receiptsService: ReceiptsService,
    private readonly settlementService: SettlementService,
    configService: ConfigService,
  ) {
    this.enabled = configService.get<boolean>('settlement.batch.enabled', false);
    this.windowMs = configService.get<number>('settlement.batch.windowMs', 60_000);
    this.maxReceipts = configService.get<number>('settlement.batch.maxReceipts', 100);
    this.tickMs = configService.get<number>('settlement.batch.tickMs', 5_000);
    this.scanLimit = configService.get<number>('settlement.batch.scanLimit', 1_000);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Batch settlement scheduler is disabled (SETTLEMENT_BATCH_ENABLED)');
      return;
    }
    this.timer = setInterval(() => {
      this.runOnce().catch((error: Error) =>
        this.logger.error(`Batch settlement tick failed: ${error.message}`),
      );
    }, this.tickMs);
    // Never keep the process alive just for the next tick.
    this.timer.unref();
    this.logger.log(
      `Batch settlement scheduler started: window ${this.windowMs}ms, cap ${this.maxReceipts} receipts`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(now: Date = new Date()): Promise<BatchRunResult> {
    const result: BatchRunResult = { ran: false, scanned: 0, batches: 0, receipts: 0, failed: 0 };
    // A slow chain must not let two ticks settle the same receipts twice.
    if (this.running) return result;
    this.running = true;
    try {
      result.ran = true;
      const pending = await this.receiptsService.findUnsettled(this.scanLimit);
      result.scanned = pending.length;

      for (const [escrowId, receipts] of groupByEscrow(pending)) {
        for (const chunk of this.dueChunks(receipts, now)) {
          try {
            await this.settleChunk(escrowId, chunk);
            result.batches += 1;
            result.receipts += chunk.length;
          } catch (error) {
            // One broken escrow must not hold back everybody else's payout.
            result.failed += 1;
            this.logger.error(`Batch for escrow ${escrowId} failed: ${(error as Error).message}`);
            break;
          }
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  /** Receipts arrive ordered oldest first, so index 0 decides the window. */
  private dueChunks(receipts: PaymentReceipt[], now: Date): PaymentReceipt[][] {
    const windowElapsed =
      now.getTime() - new Date(receipts[0].createdAt).getTime() >= this.windowMs;
    const chunks: PaymentReceipt[][] = [];
    for (let i = 0; i < receipts.length; i += this.maxReceipts) {
      const chunk = receipts.slice(i, i + this.maxReceipts);
      if (chunk.length === this.maxReceipts || windowElapsed) chunks.push(chunk);
    }
    return chunks;
  }

  private async settleChunk(escrowId: string, chunk: PaymentReceipt[]): Promise<void> {
    const amounts = chunk.map((receipt) => ethers.parseUnits(receipt.amount, AMOUNT_DECIMALS));
    const total = amounts.reduce((sum, amount) => sum + amount, 0n);
    const packed = packReceiptsCompact(
      chunk.map((receipt, i) => ({
        receiptHash: receipt.receiptHash,
        payer: receipt.fromAgent,
        payee: receipt.toAgent,
        amountMinor: amounts[i],
      })),
    );
    const settlement = await this.settlementService.settleBatch({
      escrowId,
      receiptsHash: packed.root,
      totalAmount: ethers.formatUnits(total, AMOUNT_DECIMALS),
      receiptCount: chunk.length,
      packedReceipts: packed.blob,
    });

    if (settlement.status === SettlementStatus.REJECTED) {
      // Leave the receipts unattached so the next window picks them up again.
      throw new Error(`settlement ${settlement.id} was rejected on-chain`);
    }
    await this.receiptsService.markSettled(
      chunk.map((receipt) => receipt.id),
      settlement.id,
    );
    this.logger.log(
      `Batched ${chunk.length} receipts of escrow ${escrowId} into settlement ${settlement.id} ` +
        `(${packed.bytes} calldata bytes, ${calldataGas(packed.blob)} gas)`,
    );
  }
}

function groupByEscrow(receipts: PaymentReceipt[]): Map<string, PaymentReceipt[]> {
  const groups = new Map<string, PaymentReceipt[]>();
  for (const receipt of receipts) {
    const group = groups.get(receipt.escrowId);
    if (group) group.push(receipt);
    else groups.set(receipt.escrowId, [receipt]);
  }
  return groups;
}
