/**
 * Protocol fee arithmetic. Pure functions over wei (bigint), no I/O.
 *
 *   fee = floor(amount * bps / 10000), then clamped into [minFee, maxFee],
 *   and never more than the amount itself.
 *
 * Rounding is always down, the same direction EscrowHub.sol rounds
 * (`totalAmount * feePercent / 10000`), so with equal basis points the
 * off-chain number equals the on-chain one to the wei.
 */

export const BPS_DENOMINATOR = 10_000n;
// Hard ceiling on any configured rate: 10%. A typo must not take half a payout.
export const MAX_FEE_BPS = 1_000;

export interface FeePolicy {
  /** Fee rate in basis points (1 bps = 0.01%). */
  bps: number;
  /** Floor of the fee in wei; 0 for none. */
  minFee: bigint;
  /** Cap of the fee in wei; null for none. */
  maxFee: bigint | null;
}

export type FeeBound = 'none' | 'min' | 'max' | 'amount';

export interface FeeBreakdown {
  amount: bigint;
  fee: bigint;
  net: bigint;
  bps: number;
  /** Which bound, if any, replaced the proportional fee. */
  bound: FeeBound;
}

export function assertValidPolicy(policy: FeePolicy, label: string): void {
  if (!Number.isInteger(policy.bps) || policy.bps < 0 || policy.bps > MAX_FEE_BPS) {
    throw new Error(`${label}: bps must be an integer between 0 and ${MAX_FEE_BPS}`);
  }
  if (policy.minFee < 0n) throw new Error(`${label}: minFee must not be negative`);
  if (policy.maxFee !== null && policy.maxFee < policy.minFee) {
    throw new Error(`${label}: maxFee must not be below minFee`);
  }
}

export function computeFee(amount: bigint, policy: FeePolicy): FeeBreakdown {
  if (amount < 0n) throw new Error('amount must not be negative');

  let fee = (amount * BigInt(policy.bps)) / BPS_DENOMINATOR;
  let bound: FeeBound = 'none';

  if (fee < policy.minFee) {
    fee = policy.minFee;
    bound = 'min';
  }
  if (policy.maxFee !== null && fee > policy.maxFee) {
    fee = policy.maxFee;
    bound = 'max';
  }
  // A minimum fee on a dust payment must not turn the payout negative.
  if (fee > amount) {
    fee = amount;
    bound = 'amount';
  }

  return { amount, fee, net: amount - fee, bps: policy.bps, bound };
}
