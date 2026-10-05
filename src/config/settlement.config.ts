import { registerAs } from '@nestjs/config';

function intFromEnv(raw: string | undefined, fallback: number, min: number): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

/**
 * Batch settlement tuning.
 *
 * The scheduler is opt-in: it moves money on-chain without a caller asking for
 * it, so a deployment has to switch it on explicitly.
 */
export default registerAs('settlement', () => ({
  batch: {
    enabled: process.env.SETTLEMENT_BATCH_ENABLED === 'true',
    // How long a receipt may wait before its escrow is flushed.
    windowMs: intFromEnv(process.env.SETTLEMENT_BATCH_WINDOW_MS, 60_000, 1_000),
    // Upper bound of receipts in one on-chain batch; a full batch flushes early.
    maxReceipts: intFromEnv(process.env.SETTLEMENT_BATCH_MAX_RECEIPTS, 100, 1),
    // How often the scheduler looks for due batches.
    tickMs: intFromEnv(process.env.SETTLEMENT_BATCH_TICK_MS, 5_000, 250),
    // Unsettled receipts examined per tick, across all escrows.
    scanLimit: intFromEnv(process.env.SETTLEMENT_BATCH_SCAN_LIMIT, 1_000, 1),
  },
}));
