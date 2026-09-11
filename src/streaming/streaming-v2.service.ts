export interface Stream {
  id: string;
  ratePerSecond: bigint;
  startedAt: number;
  lastClaimAt: number;
  claimed: bigint;
}

// Per-second accrual with checkpoint claims: accrued is derived from elapsed
// seconds so a claim never double-pays and can be replayed idempotently.
export class StreamingV2Service {
  accrued(stream: Stream, now: number): bigint {
    const elapsed = BigInt(Math.max(0, Math.floor((now - stream.lastClaimAt) / 1000)));
    return elapsed * stream.ratePerSecond;
  }

  claim(stream: Stream, now: number): { amount: bigint; stream: Stream } {
    const amount = this.accrued(stream, now);
    return { amount, stream: { ...stream, lastClaimAt: now, claimed: stream.claimed + amount } };
  }
}
