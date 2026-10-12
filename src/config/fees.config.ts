import { registerAs } from '@nestjs/config';

export interface RawFeePolicy {
  bps?: number;
  /** Decimal amounts in the native token, e.g. "0.0001". */
  minFee?: string;
  maxFee?: string;
}

function parsePolicies(raw: string | undefined): Record<string, RawFeePolicy> {
  if (!raw || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Refuse to boot: silently falling back to the default would charge the wrong fee.
    throw new Error('FEE_POLICIES is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('FEE_POLICIES must be a JSON object keyed by chain id');
  }
  return parsed as Record<string, RawFeePolicy>;
}

/**
 * Protocol fee settings.
 *
 * FEE_POLICIES overrides the default per chain:
 *   {"71234": {"bps": 30, "minFee": "0.0001", "maxFee": "5"}}
 * Omitted fields fall back to the FEE_DEFAULT_* values.
 */
export default registerAs('fees', () => ({
  // The chain this instance settles on; same variable the metrics labels use.
  chainId: parseInt(process.env.CHAIN_ID ?? '31337', 10),
  // 50 bps mirrors EscrowHub.feePercent.
  defaultBps: parseInt(process.env.FEE_DEFAULT_BPS ?? '50', 10),
  defaultMinFee: process.env.FEE_DEFAULT_MIN ?? '0',
  defaultMaxFee: process.env.FEE_DEFAULT_MAX ?? '',
  policies: parsePolicies(process.env.FEE_POLICIES),
}));
