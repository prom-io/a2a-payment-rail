import { NotFoundException } from '@nestjs/common';
import { ethers } from 'ethers';
import { Repository } from 'typeorm';
import { BlockchainService } from '../../common/blockchain/blockchain.service';
import { configStub } from '../../testing/stubs';
import { EscrowSession, EscrowStatus } from '../escrow/entities/escrow-session.entity';
import { MetricsService } from '../metrics/metrics.service';
import { Settlement } from '../settlement/entities/settlement.entity';
import { ReconciliationRun, ReconciliationStatus } from './entities/reconciliation-run.entity';
import { ReconciliationService } from './reconciliation.service';

const HUB = '0x' + '1'.repeat(40);
const eth = (value: string) => ethers.parseEther(value);
const idHash = (id: string) => ethers.keccak256(ethers.toUtf8Bytes(id));

interface ChainEscrow {
  deposit: bigint;
  spent: bigint;
  createdAt?: bigint;
  active?: boolean;
}

function build(options: {
  sessions?: Array<Partial<EscrowSession>>;
  settled?: Array<{ escrowId: string; totalAmount: string }>;
  chain?: Record<string, ChainEscrow>;
  balance?: bigint;
  hub?: string;
  batchSize?: number;
} = {}) {
  const sessions = (options.sessions ?? []).map((s) => ({
    status: EscrowStatus.OPEN,
    releasedAmount: '0',
    ...s,
  })) as EscrowSession[];
  const stored: ReconciliationRun[] = [];
  const runs = {
    create: (data: Partial<ReconciliationRun>) => ({ ...data }) as ReconciliationRun,
    save: jest.fn(async (run: ReconciliationRun) => {
      if (!run.id) {
        run.id = `run-${stored.length + 1}`;
        stored.unshift(run);
      }
      return run;
    }),
    find: jest.fn(async ({ take }: { take: number }) => stored.slice(0, take)),
  };
  const batchSize = options.batchSize ?? 200;
  const escrows = jest.fn(async (hash: string) => {
    const session = sessions.find((s) => idHash(s.id) === hash)!;
    const onChain = (options.chain ?? {})[session.id];
    return onChain
      ? { createdAt: 1n, active: true, ...onChain }
      : { createdAt: 0n, active: false, deposit: 0n, spent: 0n };
  });
  const getBalance = jest.fn().mockResolvedValue(options.balance ?? eth('1000'));
  const metrics = new MetricsService();
  const service = new ReconciliationService(
    runs as unknown as Repository<ReconciliationRun>,
    {
      findAndCount: jest.fn(async () => [sessions.slice(0, batchSize), sessions.length]),
    } as unknown as Repository<EscrowSession>,
    { find: jest.fn(async () => options.settled ?? []) } as unknown as Repository<Settlement>,
    {
      getContract: jest.fn().mockReturnValue({ escrows }),
      getProvider: jest.fn().mockReturnValue({ getBalance }),
    } as unknown as BlockchainService,
    metrics,
    configStub({
      ESCROW_HUB_ADDRESS: options.hub ?? HUB,
      'reconciliation.batchSize': batchSize,
    }),
  );
  return { service, escrows, getBalance, metrics, stored };
}

describe('ReconciliationService', () => {
  it('reports ok when ledger and chain agree', async () => {
    const { service, metrics } = build({
      sessions: [
        { id: 'a', depositAmount: '3', releasedAmount: '0.5' },
        { id: 'b', depositAmount: '1' },
      ],
      settled: [
        { escrowId: 'a', totalAmount: '1' },
        { escrowId: 'a', totalAmount: '0.25' },
      ],
      chain: {
        a: { deposit: eth('3'), spent: eth('1.75') },
        b: { deposit: eth('1'), spent: 0n },
      },
      balance: eth('2.5'),
    });

    const run = await service.run();

    expect(run).toMatchObject({
      status: ReconciliationStatus.OK,
      checked: 2,
      mismatches: 0,
      ledgerLocked: '2.25',
      onChainBalance: '2.5',
      error: null,
    });
    const scrape = await metrics.registry.metrics();
    expect(scrape).toMatch(/payment_rail_reconciliation_mismatches 0/);
    expect(scrape).toContain('payment_rail_reconciliation_last_run_timestamp_seconds');
  });

  it('reports every kind of per-session mismatch', async () => {
    const { service, metrics } = build({
      sessions: [
        { id: 'unknown', depositAmount: '1' },
        { id: 'deposit', depositAmount: '2' },
        { id: 'spent', depositAmount: '2' },
        { id: 'closed', depositAmount: '2' },
      ],
      settled: [{ escrowId: 'spent', totalAmount: '0.5' }],
      chain: {
        deposit: { deposit: eth('1.5'), spent: 0n },
        spent: { deposit: eth('2'), spent: eth('0.75') },
        closed: { deposit: eth('2'), spent: 0n, active: false },
      },
    });

    const run = await service.run();

    expect(run.status).toBe(ReconciliationStatus.MISMATCH);
    expect(run.details).toEqual([
      { escrowId: 'unknown', kind: 'missing_on_chain', ledger: '1.0', onChain: '0.0' },
      { escrowId: 'deposit', kind: 'deposit_mismatch', ledger: '2.0', onChain: '1.5' },
      { escrowId: 'spent', kind: 'spent_mismatch', ledger: '0.5', onChain: '0.75' },
      { escrowId: 'closed', kind: 'inactive_on_chain', ledger: '2.0', onChain: '0.0' },
    ]);
    expect(await metrics.registry.metrics()).toMatch(/payment_rail_reconciliation_mismatches 4/);
  });

  it('flags a hub that holds less than the open sessions are owed', async () => {
    const { service } = build({
      sessions: [{ id: 'a', depositAmount: '3' }],
      chain: { a: { deposit: eth('3'), spent: 0n } },
      balance: eth('2.999'),
    });

    const run = await service.run();

    expect(run.details).toEqual([
      { escrowId: null, kind: 'hub_balance_shortfall', ledger: '3.0', onChain: '2.999' },
    ]);
  });

  it('skips the hub balance check when not every open session was scanned', async () => {
    const { service } = build({
      sessions: [
        { id: 'a', depositAmount: '3' },
        { id: 'b', depositAmount: '3' },
      ],
      chain: { a: { deposit: eth('3'), spent: 0n } },
      balance: 0n,
      batchSize: 1,
    });

    const run = await service.run();

    expect(run).toMatchObject({ status: ReconciliationStatus.OK, checked: 1 });
  });

  it('is skipped, not failed, without a hub address', async () => {
    const { service, escrows } = build({ hub: '', sessions: [{ id: 'a', depositAmount: '1' }] });

    const run = await service.run();

    expect(run).toMatchObject({ status: ReconciliationStatus.SKIPPED, checked: 0 });
    expect(run.error).toMatch(/ESCROW_HUB_ADDRESS/);
    expect(escrows).not.toHaveBeenCalled();
  });

  it('records an unreachable chain as failed and leaves the mismatch gauge alone', async () => {
    const { service, getBalance, metrics } = build();
    getBalance.mockRejectedValue(new Error('rpc timeout'));

    const run = await service.run();

    expect(run).toMatchObject({ status: ReconciliationStatus.FAILED, error: 'rpc timeout' });
    expect(await metrics.registry.metrics()).toMatch(/payment_rail_reconciliation_mismatches 0/);
  });

  it('returns the latest run and 404 before the first one', async () => {
    const { service } = build();
    await expect(service.latest()).rejects.toBeInstanceOf(NotFoundException);

    await service.run(new Date('2026-06-01T00:00:00Z'));
    const second = await service.run(new Date('2026-06-02T00:00:00Z'));

    expect((await service.latest()).id).toBe(second.id);
    expect(await service.list()).toHaveLength(2);
  });

  it('does not start a timer unless an interval is configured', () => {
    const spy = jest.spyOn(global, 'setInterval');
    build().service.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
