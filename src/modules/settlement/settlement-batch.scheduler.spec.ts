import { ConfigService } from '@nestjs/config';
import { unpackReceiptsCompact } from './batch-calldata.util';
import { PaymentReceipt } from '../receipts/entities/payment-receipt.entity';
import { ReceiptsService } from '../receipts/receipts.service';
import { SettlementStatus } from './entities/settlement.entity';
import { SettlementBatchScheduler } from './settlement-batch.scheduler';
import { SettlementService } from './settlement.service';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const ESCROW_A = '11111111-1111-4111-8111-111111111111';
const ESCROW_B = '22222222-2222-4222-8222-222222222222';

let sequence = 0;

export function receipt(escrowId: string, ageMs: number, amount = '1'): PaymentReceipt {
  sequence += 1;
  return {
    id: `receipt-${sequence}`,
    escrowId,
    sessionId: 'session',
    fromAgent: '0x' + 'a'.repeat(40),
    toAgent: '0x' + 'b'.repeat(40),
    amount,
    receiptHash: '0x' + sequence.toString(16).padStart(64, '0'),
    signature: '0x' + 'c'.repeat(130),
    settlementId: null,
    createdAt: new Date(NOW.getTime() - ageMs),
  } as PaymentReceipt;
}

export function configStub(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback),
  } as unknown as ConfigService;
}

function build(pending: PaymentReceipt[], config: Record<string, unknown> = {}) {
  const receipts = {
    findUnsettled: jest.fn().mockResolvedValue(pending),
    markSettled: jest.fn().mockResolvedValue(undefined),
  };
  let settlementSeq = 0;
  const settlements = {
    settleBatch: jest.fn().mockImplementation(async (input) => {
      settlementSeq += 1;
      return { id: `settlement-${settlementSeq}`, status: SettlementStatus.PENDING, ...input };
    }),
  };
  const scheduler = new SettlementBatchScheduler(
    receipts as unknown as ReceiptsService,
    settlements as unknown as SettlementService,
    configStub({
      'settlement.batch.windowMs': 60_000,
      'settlement.batch.maxReceipts': 3,
      ...config,
    }),
  );
  return { scheduler, receipts, settlements };
}

describe('SettlementBatchScheduler', () => {
  it('leaves receipts alone while the window is open and the cap is not reached', async () => {
    const { scheduler, settlements } = build([receipt(ESCROW_A, 10_000), receipt(ESCROW_A, 5_000)]);

    const result = await scheduler.runOnce(NOW);

    expect(result).toMatchObject({ ran: true, scanned: 2, batches: 0, receipts: 0 });
    expect(settlements.settleBatch).not.toHaveBeenCalled();
  });

  it('flushes an escrow once its oldest receipt has waited the whole window', async () => {
    const pending = [receipt(ESCROW_A, 60_000, '0.5'), receipt(ESCROW_A, 1_000, '0.25')];
    const { scheduler, receipts, settlements } = build(pending);

    const result = await scheduler.runOnce(NOW);

    expect(result).toMatchObject({ batches: 1, receipts: 2, failed: 0 });
    expect(settlements.settleBatch).toHaveBeenCalledWith(
      expect.objectContaining({ escrowId: ESCROW_A, totalAmount: '0.75', receiptCount: 2 }),
    );
    const [input] = settlements.settleBatch.mock.calls[0];
    expect(unpackReceiptsCompact(input.packedReceipts).map((r) => r.amountMinor)).toEqual([
      5n * 10n ** 17n,
      25n * 10n ** 16n,
    ]);
    expect(receipts.markSettled).toHaveBeenCalledWith(
      pending.map((r) => r.id),
      'settlement-1',
    );
  });

  it('flushes a full batch early and keeps the remainder waiting', async () => {
    const pending = [1, 2, 3, 4].map(() => receipt(ESCROW_A, 1_000));
    const { scheduler, receipts, settlements } = build(pending);

    const result = await scheduler.runOnce(NOW);

    expect(result).toMatchObject({ batches: 1, receipts: 3 });
    expect(settlements.settleBatch).toHaveBeenCalledTimes(1);
    expect(receipts.markSettled.mock.calls[0][0]).toEqual(pending.slice(0, 3).map((r) => r.id));
  });

  it('batches each escrow separately', async () => {
    const { scheduler, settlements } = build([
      receipt(ESCROW_A, 90_000),
      receipt(ESCROW_B, 90_000),
      receipt(ESCROW_A, 80_000),
    ]);

    await scheduler.runOnce(NOW);

    const escrows = settlements.settleBatch.mock.calls.map(([input]) => input.escrowId);
    expect(escrows).toEqual([ESCROW_A, ESCROW_B]);
  });

  it('does not attach receipts to a batch rejected on-chain', async () => {
    const { scheduler, receipts, settlements } = build([receipt(ESCROW_A, 90_000)]);
    settlements.settleBatch.mockResolvedValue({ id: 's', status: SettlementStatus.REJECTED });

    const result = await scheduler.runOnce(NOW);

    expect(result).toMatchObject({ batches: 0, failed: 1 });
    expect(receipts.markSettled).not.toHaveBeenCalled();
  });

  it('does not start a timer unless the scheduler is enabled', () => {
    const { scheduler } = build([]);
    const spy = jest.spyOn(global, 'setInterval');

    scheduler.onModuleInit();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('SettlementBatchScheduler edge cases', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('treats a receipt exactly one window old as due and one millisecond younger as not', async () => {
    const due = build([receipt(ESCROW_A, 60_000)]);
    const early = build([receipt(ESCROW_A, 59_999)]);

    expect((await due.scheduler.runOnce(NOW)).batches).toBe(1);
    expect((await early.scheduler.runOnce(NOW)).batches).toBe(0);
  });

  it('splits an overdue backlog into batches no larger than the cap', async () => {
    const pending = Array.from({ length: 8 }, () => receipt(ESCROW_A, 120_000));
    const { scheduler, settlements } = build(pending);

    const result = await scheduler.runOnce(NOW);

    expect(result).toMatchObject({ batches: 3, receipts: 8 });
    expect(settlements.settleBatch.mock.calls.map(([input]) => input.receiptCount)).toEqual([3, 3, 2]);
  });

  it('uses a different batch hash for every chunk of the same escrow', async () => {
    const { scheduler, settlements } = build(Array.from({ length: 6 }, () => receipt(ESCROW_A, 120_000)));

    await scheduler.runOnce(NOW);

    const [first, second] = settlements.settleBatch.mock.calls.map(([input]) => input.receiptsHash);
    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });

  it('sums amounts in wei without floating point drift', async () => {
    const { scheduler, settlements } = build([
      receipt(ESCROW_A, 90_000, '0.1'),
      receipt(ESCROW_A, 90_000, '0.2'),
      receipt(ESCROW_A, 90_000, '0.000000000000000001'),
    ]);

    await scheduler.runOnce(NOW);

    expect(settlements.settleBatch.mock.calls[0][0].totalAmount).toBe('0.300000000000000001');
  });

  it('keeps settling other escrows when one of them throws', async () => {
    const { scheduler, receipts, settlements } = build([
      receipt(ESCROW_A, 90_000),
      receipt(ESCROW_B, 90_000),
    ]);
    settlements.settleBatch.mockRejectedValueOnce(new Error('database is gone'));

    const result = await scheduler.runOnce(NOW);

    expect(result).toMatchObject({ batches: 1, failed: 1, receipts: 1 });
    expect(receipts.markSettled).toHaveBeenCalledTimes(1);
  });

  it('stops working on an escrow after its first failed chunk', async () => {
    const { scheduler, settlements } = build(Array.from({ length: 6 }, () => receipt(ESCROW_A, 120_000)));
    settlements.settleBatch.mockRejectedValueOnce(new Error('boom'));

    const result = await scheduler.runOnce(NOW);

    expect(result).toMatchObject({ batches: 0, failed: 1 });
    expect(settlements.settleBatch).toHaveBeenCalledTimes(1);
  });

  it('skips a run while the previous one is still in flight', async () => {
    const { scheduler, receipts } = build([]);
    let release: (value: PaymentReceipt[]) => void = () => undefined;
    receipts.findUnsettled.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));

    const first = scheduler.runOnce(NOW);
    const second = await scheduler.runOnce(NOW);
    release([]);

    expect(second.ran).toBe(false);
    expect((await first).ran).toBe(true);
    expect((await scheduler.runOnce(NOW)).ran).toBe(true);
  });

  it('releases the in-flight guard when the scan itself fails', async () => {
    const { scheduler, receipts } = build([]);
    receipts.findUnsettled.mockRejectedValueOnce(new Error('connection refused'));

    await expect(scheduler.runOnce(NOW)).rejects.toThrow('connection refused');
    expect((await scheduler.runOnce(NOW)).ran).toBe(true);
  });

  it('asks for no more receipts than the configured scan limit', async () => {
    const { scheduler, receipts } = build([], { 'settlement.batch.scanLimit': 42 });

    await scheduler.runOnce(NOW);

    expect(receipts.findUnsettled).toHaveBeenCalledWith(42);
  });

  it('ticks on the configured interval when enabled and stops on shutdown', async () => {
    jest.useFakeTimers();
    const { scheduler, receipts } = build([], {
      'settlement.batch.enabled': true,
      'settlement.batch.tickMs': 500,
    });

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_600);
    expect(receipts.findUnsettled).toHaveBeenCalledTimes(3);

    scheduler.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(receipts.findUnsettled).toHaveBeenCalledTimes(3);
  });

  it('survives a failing tick and runs the next one', async () => {
    jest.useFakeTimers();
    const { scheduler, receipts } = build([], {
      'settlement.batch.enabled': true,
      'settlement.batch.tickMs': 500,
    });
    receipts.findUnsettled.mockRejectedValueOnce(new Error('connection refused'));

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_100);
    scheduler.onModuleDestroy();

    expect(receipts.findUnsettled).toHaveBeenCalledTimes(2);
  });
});
