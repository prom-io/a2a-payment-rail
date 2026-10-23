import { registerAs } from '@nestjs/config';

function intFromEnv(raw: string | undefined, fallback: number, min: number): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export default registerAs('reconciliation', () => ({
  // 0 keeps the periodic job off; runs can still be started through the API.
  intervalMs: intFromEnv(process.env.RECONCILIATION_INTERVAL_MS, 0, 0),
  // Open sessions compared per run (one eth_call each), oldest first.
  batchSize: intFromEnv(process.env.RECONCILIATION_BATCH_SIZE, 200, 1),
}));
