import { registerAs } from '@nestjs/config';

function intFromEnv(raw: string | undefined, fallback: number, min: number): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

/**
 * Expiry sweep: marks sessions past their TTL as expired and refunds them.
 * Opt-in, because with a hub configured every refund is a transaction.
 */
export default registerAs('refunds', () => ({
  sweepEnabled: process.env.ESCROW_EXPIRY_SWEEP_ENABLED === 'true',
  sweepMs: intFromEnv(process.env.ESCROW_EXPIRY_SWEEP_MS, 60_000, 1_000),
  // Refunds issued per sweep; the rest waits for the next one.
  sweepBatch: intFromEnv(process.env.ESCROW_EXPIRY_SWEEP_BATCH, 50, 1),
}));
