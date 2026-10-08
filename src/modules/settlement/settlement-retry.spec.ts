import { ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { BlockchainService } from '../../common/blockchain/blockchain.service';
import { Settlement, SettlementStatus } from './entities/settlement.entity';
import { configStub } from '../../testing/stubs';
import { SettlementRetryService } from './settlement-retry.service';
import { SettlementService } from './settlement.service';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const ESCROW = '11111111-1111-4111-8111-111111111111';
const HASH = '0x' + 'ab'.repeat(32);

function chainError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

function build(config: Record<string, unknown> = {}) {
  const rows = new Map<string, Settlement>();
  let seq = 0;
  const repo = {
    create: jest.fn((data) => ({ attempts: 0, txHash: null, ...data })),
    save: jest.fn(async (row: Settlement) => {
      if (!row.id) row.id = `settlement-${(seq += 1)}`;
      rows.set(row.id, row);
      return row;
    }),
    findOne: jest.fn(async ({ where }) => rows.get(where.id) ?? null),
    find: jest.fn(async () => [...rows.values()]),
  };
  const settleBatch = jest.fn();
  const provider = { getTransactionReceipt: jest.fn(), getTransaction: jest.fn() };
  const blockchain = {
    getContract: jest.fn().mockReturnValue({ settleBatch }),
    getProvider: jest.fn().mockReturnValue(provider),
  };
  const config$ = configStub({
    ESCROW_HUB_ADDRESS: '0x' + '1'.repeat(40),
    'settlement.retry.maxAttempts': 3,
    'settlement.retry.baseDelayMs': 1_000,
    'settlement.retry.maxDelayMs': 3_000,
    ...config,
  });
  const service = new SettlementService(
    repo as unknown as Repository<Settlement>,
    blockchain as unknown as BlockchainService,
    config$,
  );
  const mined = (hash = '0xtx') => ({ hash, wait: jest.fn().mockResolvedValue({ hash }) });
  return { service, repo, settleBatch, provider, mined, retry: new SettlementRetryService(service, config$) };
}

const input = { escrowId: ESCROW, receiptsHash: HASH, totalAmount: '1.5' };

describe('settlement retry queue', () => {
  it('settles on the first attempt and records the transaction hash', async () => {
    const { service, settleBatch, mined } = build();
    settleBatch.mockResolvedValue(mined('0xfirst'));

    const settlement = await service.settleBatch(input);

    expect(settlement).toMatchObject({
      status: SettlementStatus.SETTLED,
      attempts: 1,
      txHash: '0xfirst',
      nextRetryAt: null,
    });
  });

  it('queues a transient failure with exponential backoff capped at the maximum', async () => {
    const { service, settleBatch } = build({ 'settlement.retry.maxAttempts': 10 });
    settleBatch.mockRejectedValue(chainError('NETWORK_ERROR', 'rpc unreachable'));

    const settlement = await service.settleBatch(input);
    expect(settlement.status).toBe(SettlementStatus.RETRYING);
    expect(settlement.lastError).toBe('rpc unreachable');

    const delays: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await service.attempt(settlement, NOW);
      delays.push(settlement.nextRetryAt!.getTime() - NOW.getTime());
    }
    expect(delays).toEqual([2_000, 3_000, 3_000]);
  });

  it('moves to dead letter once the attempts are used up', async () => {
    const { service, settleBatch, retry, repo } = build();
    settleBatch.mockRejectedValue(chainError('TIMEOUT'));
    const settlement = await service.settleBatch(input);
    repo.find.mockResolvedValue([settlement]);

    await retry.processDue(NOW);
    const last = await retry.processDue(NOW);

    expect(settlement).toMatchObject({ status: SettlementStatus.DEAD_LETTER, attempts: 3, nextRetryAt: null });
    expect(last).toMatchObject({ attempted: 1, deadLettered: 1, settled: 0 });
  });

  it('rejects a revert at once instead of retrying it', async () => {
    const { service, settleBatch } = build();
    settleBatch.mockRejectedValue(chainError('CALL_EXCEPTION', 'EscrowHub: exceeds budget'));

    const settlement = await service.settleBatch(input);

    expect(settlement).toMatchObject({ status: SettlementStatus.REJECTED, attempts: 1, nextRetryAt: null });
  });

  it('does not send a second transaction while the first one is still pending', async () => {
    const { service, settleBatch, provider } = build();
    const lost = { hash: '0xlost', wait: jest.fn().mockRejectedValue(chainError('TIMEOUT')) };
    settleBatch.mockResolvedValue(lost);
    const settlement = await service.settleBatch(input);
    provider.getTransactionReceipt.mockResolvedValue(null);
    provider.getTransaction.mockResolvedValue({ hash: '0xlost' });

    await service.attempt(settlement, NOW);

    expect(settleBatch).toHaveBeenCalledTimes(1);
    expect(settlement).toMatchObject({ status: SettlementStatus.RETRYING, attempts: 1 });
  });

  it('adopts an earlier transaction that was mined after the wait failed', async () => {
    const { service, settleBatch, provider } = build();
    settleBatch.mockResolvedValue({ hash: '0xlost', wait: jest.fn().mockRejectedValue(chainError('TIMEOUT')) });
    const settlement = await service.settleBatch(input);
    provider.getTransactionReceipt.mockResolvedValue({ status: 1 });

    await service.attempt(settlement, NOW);

    expect(settleBatch).toHaveBeenCalledTimes(1);
    expect(settlement).toMatchObject({ status: SettlementStatus.SETTLED, txHash: '0xlost' });
  });

  it('replays a dead-lettered settlement with a fresh set of attempts', async () => {
    const { service, settleBatch, mined } = build({ 'settlement.retry.maxAttempts': 1 });
    settleBatch.mockRejectedValueOnce(chainError('SERVER_ERROR'));
    const settlement = await service.settleBatch(input);
    expect(settlement.status).toBe(SettlementStatus.DEAD_LETTER);

    settleBatch.mockResolvedValue(mined('0xreplayed'));
    const replayed = await service.replay(settlement.id);

    expect(replayed).toMatchObject({ status: SettlementStatus.SETTLED, attempts: 1, lastError: null });
  });

  it('refuses to replay a settlement that is not dead-lettered or rejected', async () => {
    const { service, settleBatch, mined } = build();
    settleBatch.mockResolvedValue(mined());
    const settlement = await service.settleBatch(input);

    await expect(service.replay(settlement.id)).rejects.toBeInstanceOf(ConflictException);
  });
});
