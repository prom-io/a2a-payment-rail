import { Stream } from './streaming-v2.service';

// Settle accrued at the old rate before changing it, so a mid-flight rate change
// prorates instead of retroactively repricing already-streamed seconds.
export function changeRate(stream: Stream, newRate: bigint, now: number): Stream {
  const elapsed = BigInt(Math.max(0, Math.floor((now - stream.lastClaimAt) / 1000)));
  const settled = elapsed * stream.ratePerSecond;
  return { ...stream, ratePerSecond: newRate, lastClaimAt: now, claimed: stream.claimed + settled };
}

export function topUp(stream: Stream, _amount: bigint): Stream {
  // Balance lives in escrow on-chain; top-up only extends runway, no state change here.
  return stream;
}
