import { BadGatewayException, ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { BlockchainService } from '../../common/blockchain/blockchain.service';
import { configStub } from '../../testing/stubs';
import { WebhooksService } from '../webhooks/webhooks.service';
import { EscrowRelease, ReleaseStatus } from './entities/escrow-release.entity';
import { EscrowSession, EscrowStatus } from './entities/escrow-session.entity';
import { EscrowReleaseService, toBalance } from './escrow-release.service';
import { EscrowService } from './escrow.service';

const ESCROW = '11111111-1111-4111-8111-111111111111';
const WEI = 10n ** 18n;
const wei = (value: string) => BigInt(Math.round(Number(value) * 1e6)) * 10n ** 12n;
const dec = (value: bigint) => (Number(value / 10n ** 12n) / 1e6).toString();

/** A session whose conditional UPDATE behaves like the SQL in reserve(). */
function build(options: { status?: EscrowStatus; deposit?: string; budget?: string; hub?: string } = {}) {
  const session = {
    id: ESCROW,
    status: options.status ?? EscrowStatus.OPEN,
    depositAmount: options.deposit ?? '3',
    budgetLimit: options.budget ?? options.deposit ?? '3',
    releasedAmount: '0',
  } as EscrowSession;

  const sessions = {
    createQueryBuilder: () => {
      const qb: any = { params: {} as Record<string, string> };
      for (const m of ['update', 'set', 'where', 'andWhere']) qb[m] = () => qb;
      qb.setParameters = (params: Record<string, string>) => {
        qb.params = params;
        return qb;
      };
      qb.execute = async () => {
        const next = wei(session.releasedAmount) + wei(qb.params.delta);
        const ceiling = wei(session.depositAmount) < wei(session.budgetLimit)
          ? wei(session.depositAmount)
          : wei(session.budgetLimit);
        if (session.status !== EscrowStatus.OPEN || next < 0n || next > ceiling) return { affected: 0 };
        session.releasedAmount = dec(next);
        return { affected: 1 };
      };
      return qb;
    },
  };
  const rows: EscrowRelease[] = [];
  const releases = {
    create: (data: Partial<EscrowRelease>) => ({ txHash: null, ...data }) as EscrowRelease,
    save: jest.fn(async (row: EscrowRelease) => {
      if (!row.id) {
        row.id = `release-${rows.length + 1}`;
        rows.push(row);
      }
      return row;
    }),
    find: jest.fn(async () => rows),
  };
  const settleBatch = jest.fn().mockResolvedValue({ wait: jest.fn().mockResolvedValue({ hash: '0xpaid' }) });
  const webhooks = { emit: jest.fn().mockResolvedValue(undefined) };
  const service = new EscrowReleaseService(
    sessions as unknown as Repository<EscrowSession>,
    releases as unknown as Repository<EscrowRelease>,
    { findById: jest.fn().mockResolvedValue(session) } as unknown as EscrowService,
    { getContract: jest.fn().mockReturnValue({ settleBatch }) } as unknown as BlockchainService,
    webhooks as unknown as WebhooksService,
    configStub({ ESCROW_HUB_ADDRESS: options.hub ?? '' }),
  );
  return { service, session, rows, settleBatch, webhooks };
}

describe('EscrowReleaseService', () => {
  it('releases part of the escrow and tracks what remains', async () => {
    const { service, webhooks } = build();

    const first = await service.release(ESCROW, { amount: '1.25' });
    const second = await service.release(ESCROW, { amount: '0.75', note: 'milestone 2' });

    expect(first.balance).toMatchObject({ releasedAmount: '1.25', remainingBalance: '1.75' });
    expect(second.balance).toMatchObject({ releasedAmount: '2.0', remainingBalance: '1.0' });
    expect(second.release).toMatchObject({ amount: '0.75', note: 'milestone 2', status: ReleaseStatus.COMPLETED });
    expect(webhooks.emit).toHaveBeenLastCalledWith(
      'escrow.released',
      expect.objectContaining({ escrowId: ESCROW, amount: '0.75', remainingBalance: '1.0' }),
    );
  });

  it('allows releasing exactly the remainder and nothing after it', async () => {
    const { service, rows } = build();
    await service.release(ESCROW, { amount: '3' });

    await expect(service.release(ESCROW, { amount: '0.000001' })).rejects.toThrow(/remaining balance 0\.0/);
    expect(rows).toHaveLength(1);
  });

  it('caps releases at the budget when it is below the deposit', async () => {
    const { service } = build({ deposit: '5', budget: '2' });

    await expect(service.release(ESCROW, { amount: '2.5' })).rejects.toBeInstanceOf(ConflictException);
    expect((await service.release(ESCROW, { amount: '2' })).balance.remainingBalance).toBe('0.0');
  });

  it.each([EscrowStatus.CLOSED, EscrowStatus.EXPIRED, EscrowStatus.CANCELLED, EscrowStatus.DISPUTED])(
    'refuses to release from a session that is %s',
    async (status) => {
      const { service, rows } = build({ status });

      await expect(service.release(ESCROW, { amount: '1' })).rejects.toThrow(/only an open session/);
      expect(rows).toHaveLength(0);
    },
  );

  it('rejects a zero amount', async () => {
    const { service } = build();
    await expect(service.release(ESCROW, { amount: '0.0' })).rejects.toThrow(/greater than zero/);
  });

  it('pays the payee on-chain and stores the transaction hash', async () => {
    const { service, settleBatch } = build({ hub: '0x' + '1'.repeat(40) });

    const { release } = await service.release(ESCROW, { amount: '1.5' });

    expect(release.txHash).toBe('0xpaid');
    expect(settleBatch.mock.calls[0][2]).toBe((15n * WEI) / 10n);
  });

  it('gives the amount back to the session when the on-chain payout fails', async () => {
    const { service, session, settleBatch, rows, webhooks } = build({ hub: '0x' + '1'.repeat(40) });
    await service.release(ESCROW, { amount: '1' });
    settleBatch.mockRejectedValueOnce(new Error('EscrowHub: exceeds budget'));

    await expect(service.release(ESCROW, { amount: '1' })).rejects.toBeInstanceOf(BadGatewayException);

    expect(session.releasedAmount).toBe('1');
    expect(rows[1]).toMatchObject({ status: ReleaseStatus.FAILED, lastError: 'EscrowHub: exceeds budget' });
    expect(webhooks.emit).toHaveBeenCalledTimes(1);
  });

  it('never reports a negative remaining balance', () => {
    const overdrawn = { id: ESCROW, status: EscrowStatus.OPEN, depositAmount: '1', budgetLimit: '1', releasedAmount: '2' };
    expect(toBalance(overdrawn as EscrowSession).remainingBalance).toBe('0.0');
  });
});
