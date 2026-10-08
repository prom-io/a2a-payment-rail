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
  retry: {
    enabled: process.env.SETTLEMENT_RETRY_ENABLED !== 'false',
    // Attempts per settlement, the first submission included, before dead letter.
    maxAttempts: intFromEnv(process.env.SETTLEMENT_RETRY_MAX_ATTEMPTS, 5, 1),
    // Backoff: base, 2x base, 4x base ... capped at the maximum.
    baseDelayMs: intFromEnv(process.env.SETTLEMENT_RETRY_BASE_DELAY_MS, 30_000, 100),
    maxDelayMs: intFromEnv(process.env.SETTLEMENT_RETRY_MAX_DELAY_MS, 3_600_000, 100),
    tickMs: intFromEnv(process.env.SETTLEMENT_RETRY_TICK_MS, 15_000, 250),
    batchSize: intFromEnv(process.env.SETTLEMENT_RETRY_BATCH_SIZE, 20, 1),
  },
}));
