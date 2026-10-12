import { ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { configStub } from '../../testing/stubs';
import { FeeLedgerEntry, FeeLedgerEntryType } from './entities/fee-ledger-entry.entity';
import { FeeLedgerService } from './fee-ledger.service';
import { FeePolicyService } from './fee-policy.service';

const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

/** In-memory ledger behind the slice of the TypeORM API the service uses. */
function ledger() {
  const rows: FeeLedgerEntry[] = [];
  let seq = 0;
  const insert = async (row: FeeLedgerEntry) => {
    if (row.settlementId && rows.some((r) => r.settlementId === row.settlementId)) {
      throw Object.assign(new Error('duplicate'), { driverError: { code: '23505' } });
    }
    row.id = `entry-${(seq += 1)}`;
    rows.push(row);
    return row;
  };
  const sum = (chainId: string, type: FeeLedgerEntryType) =>
    rows
      .filter((r) => r.chainId === chainId && r.type === type)
      .reduce((total, r) => total + Number(r.amount), 0)
      .toFixed(18);

  const manager: any = {
    query: jest.fn().mockResolvedValue([]),
    create: (_entity: unknown, data: FeeLedgerEntry) => ({ ...data }),
    save: jest.fn(insert),
    createQueryBuilder: () => {
      let chainId = '';
      const qb: any = {
        select: () => qb,
        addSelect: () => qb,
        groupBy: () => qb,
        where: (_sql: string, params: { chainId: string }) => {
          chainId = params.chainId;
          return qb;
        },
        getRawMany: async () =>
          Object.values(FeeLedgerEntryType).map((type) => ({ type, total: sum(chainId, type) })),
      };
      return qb;
    },
  };
  manager.transaction = jest.fn((work: (m: unknown) => unknown) => work(manager));

  const repo = {
    manager,
    create: (data: FeeLedgerEntry) => ({ ...data }),
    save: jest.fn(insert),
    find: jest.fn(async () => rows),
  };
  const service = new FeeLedgerService(
    repo as unknown as Repository<FeeLedgerEntry>,
    new FeePolicyService(configStub({ 'fees.chainId': 71234 })),
  );
  return { service, rows, manager };
}

describe('FeeLedgerService', () => {
  it('accrues the fee of a settlement on the configured chain', async () => {
    const { service, rows } = ledger();

    await service.accrue({ id: 'settlement-1', feeAmount: '0.005000000000000000' });

    expect(rows[0]).toMatchObject({
      chainId: '71234',
      type: FeeLedgerEntryType.ACCRUAL,
      settlementId: 'settlement-1',
    });
    expect(await service.balance()).toEqual({
      chainId: 71234,
      accrued: '0.005',
      withdrawn: '0.0',
      available: '0.005',
    });
  });

  it('does not accrue the same settlement twice', async () => {
    const { service, rows } = ledger();

    await service.accrue({ id: 'settlement-1', feeAmount: '0.5' });
    await expect(service.accrue({ id: 'settlement-1', feeAmount: '0.5' })).resolves.toBeNull();

    expect(rows).toHaveLength(1);
  });

  it('skips settlements without a fee', async () => {
    const { service, rows } = ledger();

    await service.accrue({ id: 'a', feeAmount: null });
    await service.accrue({ id: 'b', feeAmount: '0.000000000000000000' });

    expect(rows).toHaveLength(0);
  });

  it('withdraws under the advisory lock and reports the new balance', async () => {
    const { service, manager } = ledger();
    await service.accrue({ id: 's1', feeAmount: '1.5' });

    const { entry, balance } = await service.withdraw({ amount: '0.4', recipient: RECIPIENT });

    expect(manager.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock($1, $2)', [7001, 71234]);
    expect(entry).toMatchObject({
      type: FeeLedgerEntryType.WITHDRAWAL,
      amount: '0.4',
      recipient: RECIPIENT.toLowerCase(),
    });
    expect(balance).toEqual({ chainId: 71234, accrued: '1.5', withdrawn: '0.4', available: '1.1' });
  });

  it('allows withdrawing exactly the available balance and nothing beyond it', async () => {
    const { service } = ledger();
    await service.accrue({ id: 's1', feeAmount: '1' });

    await service.withdraw({ amount: '1', recipient: RECIPIENT });

    await expect(
      service.withdraw({ amount: '0.000000000000000001', recipient: RECIPIENT }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('keeps the balances of different chains apart', async () => {
    const { service } = ledger();
    await service.accrue({ id: 's1', feeAmount: '2' }, 1);

    await expect(service.withdraw({ amount: '1', recipient: RECIPIENT })).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.withdraw({ amount: '1', recipient: RECIPIENT, chainId: 1 })).resolves.toBeDefined();
    expect((await service.balance(1)).available).toBe('1.0');
  });

  it('rejects a zero withdrawal', async () => {
    const { service } = ledger();
    await expect(service.withdraw({ amount: '0.0', recipient: RECIPIENT })).rejects.toThrow(/greater than zero/);
  });
});
