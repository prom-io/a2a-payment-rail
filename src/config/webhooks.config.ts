import { registerAs } from '@nestjs/config';

function intFromEnv(raw: string | undefined, fallback: number, min: number): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export default registerAs('webhooks', () => ({
  // How long a subscriber may take to answer before the attempt counts as failed.
  timeoutMs: intFromEnv(process.env.WEBHOOK_TIMEOUT_MS, 5_000, 100),
  // Plain http endpoints are fine on a laptop and never in production.
  allowHttp:
    process.env.WEBHOOK_ALLOW_HTTP !== undefined
      ? process.env.WEBHOOK_ALLOW_HTTP === 'true'
      : process.env.NODE_ENV !== 'production',
  retry: {
    enabled: process.env.WEBHOOK_RETRY_ENABLED !== 'false',
    // Attempts per delivery, the first one included.
    maxAttempts: intFromEnv(process.env.WEBHOOK_MAX_ATTEMPTS, 6, 1),
    // Backoff: base, 2x base, 4x base ... capped at the maximum.
    baseDelayMs: intFromEnv(process.env.WEBHOOK_RETRY_BASE_DELAY_MS, 10_000, 100),
    maxDelayMs: intFromEnv(process.env.WEBHOOK_RETRY_MAX_DELAY_MS, 3_600_000, 100),
    tickMs: intFromEnv(process.env.WEBHOOK_RETRY_TICK_MS, 10_000, 250),
    batchSize: intFromEnv(process.env.WEBHOOK_RETRY_BATCH_SIZE, 50, 1),
  },
}));
