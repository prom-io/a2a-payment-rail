import { BPS_DENOMINATOR, computeFee, FeePolicy, MAX_FEE_BPS } from './fee-policy';

/**
 * Property tests for the fee arithmetic. Inputs come from a seeded generator,
 * so a failure is reproducible: the seed and the case are in the message.
 */

const RUNS = 2_000;
const SEED = 0x5eed1e55;

/** mulberry32: small deterministic PRNG, good enough to spread test inputs. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = prng(SEED);

/** Amounts spread over magnitudes from 1 wei up to ~10^30 wei, plus edge values. */
function randomAmount(): bigint {
  const pick = random();
  if (pick < 0.03) return 0n;
  if (pick < 0.06) return 1n;
  const digits = 1 + Math.floor(random() * 30);
  let value = 0n;
  for (let i = 0; i < digits; i += 1) value = value * 10n + BigInt(Math.floor(random() * 10));
  return value;
}

function randomPolicy(): FeePolicy {
  const bps = random() < 0.1 ? [0, 1, MAX_FEE_BPS][Math.floor(random() * 3)] : Math.floor(random() * (MAX_FEE_BPS + 1));
  const minFee = random() < 0.5 ? 0n : randomAmount() / 1_000n;
  const maxFee = random() < 0.4 ? null : minFee + randomAmount() / 100n;
  return { bps, minFee, maxFee };
}

function forAll(check: (amount: bigint, policy: FeePolicy) => void): void {
  for (let run = 0; run < RUNS; run += 1) {
    const amount = randomAmount();
    const policy = randomPolicy();
    try {
      check(amount, policy);
    } catch (error) {
      const context = `seed=${SEED} run=${run} amount=${amount} bps=${policy.bps} min=${policy.minFee} max=${policy.maxFee}`;
      throw new Error(`${(error as Error).message}\n  at ${context}`);
    }
  }
}

const unbounded = (bps: number): FeePolicy => ({ bps, minFee: 0n, maxFee: null });

describe('fee policy properties', () => {
  it('conserves value: fee + net is always the amount', () => {
    forAll((amount, policy) => {
      const { fee, net } = computeFee(amount, policy);
      expect(fee + net).toBe(amount);
    });
  });

  it('never produces a negative fee or a negative payout', () => {
    forAll((amount, policy) => {
      const { fee, net } = computeFee(amount, policy);
      expect(fee >= 0n).toBe(true);
      expect(net >= 0n).toBe(true);
    });
  });

  it('never charges above the cap', () => {
    forAll((amount, policy) => {
      if (policy.maxFee === null) return;
      expect(computeFee(amount, policy).fee <= policy.maxFee).toBe(true);
    });
  });

  it('charges at least the minimum whenever the amount can cover it', () => {
    forAll((amount, policy) => {
      const { fee } = computeFee(amount, policy);
      const floor = policy.minFee < amount ? policy.minFee : amount;
      expect(fee >= floor).toBe(true);
    });
  });

  it('rounds the proportional fee down, by less than one wei', () => {
    forAll((amount, policy) => {
      const { fee } = computeFee(amount, unbounded(policy.bps));
      const scaled = amount * BigInt(policy.bps);
      // fee <= exact < fee + 1, compared without leaving the integers
      expect(fee * BPS_DENOMINATOR <= scaled).toBe(true);
      expect(scaled < (fee + 1n) * BPS_DENOMINATOR).toBe(true);
    });
  });

  it('matches the contract formula exactly when no bound is configured', () => {
    forAll((amount, policy) => {
      // EscrowHub.sol: uint256 fee = (totalAmount * feePercent) / 10000;
      expect(computeFee(amount, unbounded(policy.bps)).fee).toBe((amount * BigInt(policy.bps)) / 10_000n);
    });
  });

  it('reports the bound that decided the fee', () => {
    forAll((amount, policy) => {
      const proportional = (amount * BigInt(policy.bps)) / BPS_DENOMINATOR;
      const { fee, bound } = computeFee(amount, policy);
      if (bound === 'none') expect(fee).toBe(proportional);
      if (bound === 'min') expect(fee).toBe(policy.minFee);
      if (bound === 'max') expect(fee).toBe(policy.maxFee);
      if (bound === 'amount') expect(fee).toBe(amount);
    });
  });

  it('is monotonic: a larger amount never pays a smaller fee', () => {
    forAll((amount, policy) => {
      const bigger = amount + randomAmount();
      expect(computeFee(bigger, policy).fee >= computeFee(amount, policy).fee).toBe(true);
    });
  });

  it('is monotonic in the rate when no bound applies', () => {
    forAll((amount, policy) => {
      if (policy.bps === MAX_FEE_BPS) return;
      const lower = computeFee(amount, unbounded(policy.bps)).fee;
      const higher = computeFee(amount, unbounded(policy.bps + 1)).fee;
      expect(higher >= lower).toBe(true);
    });
  });

  it('loses at most one wei when a payment is split in two', () => {
    forAll((amount, policy) => {
      const first = amount / 3n;
      const whole = computeFee(amount, unbounded(policy.bps)).fee;
      const parts =
        computeFee(first, unbounded(policy.bps)).fee +
        computeFee(amount - first, unbounded(policy.bps)).fee;
      // Flooring twice can only lose, and by less than one wei per part, so by at most one wei in total.
      expect(parts <= whole).toBe(true);
      expect(whole - parts <= 1n).toBe(true);
    });
  });

  it('keeps the total charged under a cap regardless of how large the amount grows', () => {
    const policy: FeePolicy = { bps: MAX_FEE_BPS, minFee: 0n, maxFee: 10n ** 18n };
    for (let exponent = 0; exponent <= 60; exponent += 1) {
      const { fee, bound } = computeFee(10n ** BigInt(exponent), policy);
      expect(fee <= 10n ** 18n).toBe(true);
      // 10% of 10^19 is the first proportional fee that reaches the cap
      expect(bound).toBe(exponent > 19 ? 'max' : 'none');
    }
  });

  it('is deterministic for a fixed seed', () => {
    const a = prng(42);
    const b = prng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
