import { ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { configStub } from '../../testing/stubs';
import { EscrowSession, EscrowStatus } from './entities/escrow-session.entity';
import { SpendingLimit } from './entities/spending-limit.entity';
import { SpendingLimitService } from './spending-limit.service';

const PAYER = '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const NOW = new Date('2026-06-02T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

interface Opened {
  agentA: string;
  depositAmount: string;
  createdAt: Date;
  status?: EscrowStatus;
}

/** The window query evaluated over an in-memory list of sessions. */
function build(config: Record<string, unknown>, opened: Opened[] = []) {
  const overrides = new Map<string, SpendingLimit>();
  const manager: any = {
    query: jest.fn().mockResolvedValue([]),
    createQueryBuilder: () => {
      const params: Record<string, any> = {};
      const qb: any = { select: () => qb };
      qb.where = qb.andWhere = (_sql: string, p: Record<string, unknown>) => {
        Object.assign(params, p);
        return qb;
      };
      qb.getRawOne = async () => ({
        total: opened
          .filter(
            (s) =>
              s.agentA.toLowerCase() === params.address &&
              s.createdAt.getTime() > params.since.getTime() &&
              (s.status ?? EscrowStatus.OPEN) !== params.cancelled,
          )
          .reduce((sum, s) => sum + Number(s.depositAmount), 0)
          .toFixed(18),
      });
      return qb;
    },
  };
  manager.transaction = jest.fn((work: (m: unknown) => unknown) => work(manager));

  const limits = {
    create: (data: SpendingLimit) => data,
    findOne: jest.fn(async ({ where }) => overrides.get(where.payer) ?? null),
    save: jest.fn(async (row: SpendingLimit) => {
      overrides.set(row.payer, row);
      return row;
    }),
    delete: jest.fn(async ({ payer }) => overrides.delete(payer)),
  };
  const service = new SpendingLimitService(
    limits as unknown as Repository<SpendingLimit>,
    { manager } as unknown as Repository<EscrowSession>,
    configStub(config),
  );
  const open = (payer: string, amount: string) => {
    const insert = jest.fn(async () => {
      opened.push({ agentA: payer, depositAmount: amount, createdAt: NOW });
      return 'saved';
    });
    return { insert, result: service.withinLimit(payer, amount, insert, NOW) };
  };
  return { service, manager, open, opened };
}

describe('SpendingLimitService', () => {
  it('does not limit anybody when no default and no override is configured', async () => {
    const { service, manager, open } = build({});

    await expect(open(PAYER, '1000000').result).resolves.toBe('saved');

    expect(manager.transaction).not.toHaveBeenCalled();
    expect(await service.status(PAYER, NOW)).toMatchObject({ dailyLimit: null, remaining: null, source: 'none' });
  });

  it('lets a payer spend up to the limit and not a wei more', async () => {
    const { open } = build({ SPENDING_LIMIT_DAILY_DEFAULT: '10' }, [
      { agentA: PAYER, depositAmount: '6', createdAt: hoursAgo(2) },
    ]);

    await expect(open(PAYER, '4').result).resolves.toBe('saved');

    const over = open(PAYER, '0.000000000000000001');
    await expect(over.result).rejects.toBeInstanceOf(ForbiddenException);
    await expect(over.result).rejects.toThrow(/10\.0 per 24h, 10\.0 already spent, 0\.0 remaining/);
    expect(over.insert).not.toHaveBeenCalled();
  });

  it('rolls the window: deposits older than 24 hours no longer count', async () => {
    const { service, open } = build({ SPENDING_LIMIT_DAILY_DEFAULT: '10' }, [
      { agentA: PAYER, depositAmount: '9', createdAt: hoursAgo(24.01) },
      { agentA: PAYER, depositAmount: '3', createdAt: hoursAgo(23.99) },
    ]);

    expect(await service.status(PAYER, NOW)).toMatchObject({ spent: '3.0', remaining: '7.0' });
    await expect(open(PAYER, '7').result).resolves.toBe('saved');
    await expect(open(PAYER, '1').result).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('honours a custom window length', async () => {
    const { service } = build(
      { SPENDING_LIMIT_DAILY_DEFAULT: '10', SPENDING_LIMIT_WINDOW_HOURS: '1' },
      [{ agentA: PAYER, depositAmount: '9', createdAt: hoursAgo(2) }],
    );

    expect(await service.status(PAYER, NOW)).toMatchObject({
      spent: '0.0',
      windowHours: 1,
      windowStart: hoursAgo(1).toISOString(),
    });
  });

  it('counts per payer, case-insensitively, and ignores cancelled sessions', async () => {
    const { service } = build({ SPENDING_LIMIT_DAILY_DEFAULT: '10' }, [
      { agentA: PAYER.toLowerCase(), depositAmount: '2', createdAt: hoursAgo(1) },
      { agentA: PAYER, depositAmount: '3', createdAt: hoursAgo(1) },
      { agentA: PAYER, depositAmount: '4', createdAt: hoursAgo(1), status: EscrowStatus.CANCELLED },
      { agentA: OTHER, depositAmount: '9', createdAt: hoursAgo(1) },
    ]);

    expect((await service.status(PAYER.toUpperCase().replace('0X', '0x'), NOW)).spent).toBe('5.0');
    expect((await service.status(OTHER, NOW)).spent).toBe('9.0');
  });

  it('prefers the payer override over the default, and "0" lifts the limit', async () => {
    const { service, open } = build({ SPENDING_LIMIT_DAILY_DEFAULT: '10' });

    await service.setLimit(PAYER, '2.5');
    expect(await service.status(PAYER, NOW)).toMatchObject({ dailyLimit: '2.5', source: 'override' });
    await expect(open(PAYER, '3').result).rejects.toBeInstanceOf(ForbiddenException);
    await expect(open(OTHER, '3').result).resolves.toBe('saved');

    await service.setLimit(PAYER, '0');
    await expect(open(PAYER, '500').result).resolves.toBe('saved');

    await service.clearLimit(PAYER);
    expect(await service.status(PAYER, NOW)).toMatchObject({ dailyLimit: '10.0', source: 'default' });
  });

  it('checks and inserts under a per-payer advisory lock', async () => {
    const { manager, open } = build({ SPENDING_LIMIT_DAILY_DEFAULT: '10' });

    await open(PAYER, '1').result;

    expect(manager.transaction).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
      7002,
      PAYER.toLowerCase(),
    ]);
  });

  it('refuses to start with a malformed default', () => {
    expect(() => build({ SPENDING_LIMIT_DAILY_DEFAULT: 'ten' })).toThrow(/SPENDING_LIMIT_DAILY_DEFAULT/);
  });
});
