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
}));
