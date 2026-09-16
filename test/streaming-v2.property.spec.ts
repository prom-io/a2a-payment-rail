import { StreamingV2Service, Stream } from '../src/streaming/streaming-v2.service';
import { changeRate } from '../src/streaming/stream-mutations';

const svc = new StreamingV2Service();
const mk = (rate: bigint, t: number): Stream => ({ id: 's', ratePerSecond: rate, startedAt: t, lastClaimAt: t, claimed: 0n });

describe('streaming v2 accrual (property)', () => {
  it('accrual equals elapsed seconds times rate', () => {
    for (let i = 0; i < 200; i++) {
      const rate = BigInt(1 + (i % 50));
      const secs = i % 120;
      const s = mk(rate, 0);
      expect(svc.accrued(s, secs * 1000)).toBe(BigInt(secs) * rate);
    }
  });
  it('rate change never reprices past seconds', () => {
    const s = mk(10n, 0);
    const changed = changeRate(s, 100n, 10_000);
    expect(changed.claimed).toBe(100n); // 10s * 10, not * 100
    expect(svc.accrued(changed, 20_000).valueOf()).toBe(1000n); // next 10s at new rate
  });
});
