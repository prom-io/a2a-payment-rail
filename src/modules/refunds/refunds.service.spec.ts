import { ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { BlockchainService } from '../../common/blockchain/blockchain.service';
import { configStub } from '../../testing/stubs';
import { EscrowSession, EscrowStatus } from '../escrow/entities/escrow-session.entity';
import { EscrowService } from '../escrow/escrow.service';
import { Settlement } from '../settlement/entities/settlement.entity';
import { StreamClaim } from '../streaming/entities/stream-claim.entity';
import { WebhooksService } from '../webhooks/webhooks.service';
import { EscrowRefund, RefundReason, RefundStatus } from './entities/escrow-refund.entity';
import { RefundsService } from './refunds.service';

const ESCROW = '11111111-1111-4111-8111-111111111111';

function sumRepo(total: string) {
  const qb: any = { getRawOne: jest.fn().mockResolvedValue({ total }) };
  for (const method of ['select', 'where', 'andWhere']) qb[method] = jest.fn().mockReturnValue(qb);
  return { createQueryBuilder: jest.fn().mockReturnValue(qb) };
}

function build(options: {
  status?: EscrowStatus;
  deposit?: string;
  settled?: string;
  claimed?: string;
  hub?: string;
} = {}) {
  const session = {
    id: ESCROW,
    status: options.status ?? EscrowStatus.EXPIRED,
    depositAmount: options.deposit ?? '2.000000000000000000',
  } as EscrowSession;
  const rows: EscrowRefund[] = [];
  const refunds = {
    create: (data: Partial<EscrowRefund>) => ({ txHash: null, ...data }) as EscrowRefund,
    findOne: jest.fn(async (): Promise<EscrowRefund | null> => rows[0] ?? null),
    save: jest.fn(async (row: EscrowRefund) => {
      if (!row.id) {
        row.id = `refund-${rows.length + 1}`;
        rows.push(row);
      }
      return row;
    }),
  };
  const escrow = {
    findById: jest.fn().mockResolvedValue(session),
    expireDue: jest.fn().mockResolvedValue(0),
    findAwaitingRefund: jest.fn().mockResolvedValue([]),
    markRefunded: jest.fn().mockResolvedValue(undefined),
  };
  const emergencyClose = jest.fn().mockResolvedValue({ hash: '0xrefund', wait: jest.fn().mockResolvedValue({}) });
  const webhooks = { emit: jest.fn().mockResolvedValue(undefined) };
  const service = new RefundsService(
    refunds as unknown as Repository<EscrowRefund>,
    sumRepo(options.settled ?? '0') as unknown as Repository<Settlement>,
    sumRepo(options.claimed ?? '0') as unknown as Repository<StreamClaim>,
    escrow as unknown as EscrowService,
    { getContract: jest.fn().mockReturnValue({ emergencyClose }) } as unknown as BlockchainService,
    webhooks as unknown as WebhooksService,
    configStub({ ESCROW_HUB_ADDRESS: options.hub ?? '' }),
  );
  return { service, session, rows, refunds, escrow, emergencyClose, webhooks };
}

describe('RefundsService', () => {
  it('refunds the whole deposit of an untouched expired session', async () => {
    const { service, escrow, webhooks } = build();

    const refund = await service.refund(ESCROW);

    expect(refund).toMatchObject({
      escrowId: ESCROW,
      reason: RefundReason.EXPIRED,
      depositAmount: '2.0',
      spentAmount: '0.0',
      refundAmount: '2.0',
      status: RefundStatus.COMPLETED,
    });
    expect(escrow.markRefunded).toHaveBeenCalledWith(ESCROW);
    expect(webhooks.emit).toHaveBeenCalledWith(
      'escrow.refunded',
      expect.objectContaining({ escrowId: ESCROW, refundAmount: '2.0', reason: 'expired' }),
    );
  });

  it('subtracts settled batches and stream claims', async () => {
    const { service } = build({ status: EscrowStatus.CANCELLED, settled: '0.75', claimed: '0.5' });

    expect(await service.refund(ESCROW)).toMatchObject({
      reason: RefundReason.CANCELLED,
      spentAmount: '1.25',
      refundAmount: '0.75',
    });
  });

  it('never refunds a negative amount', async () => {
    const { service } = build({ settled: '2.5' });

    expect((await service.refund(ESCROW)).refundAmount).toBe('0.0');
  });

  it.each([EscrowStatus.OPEN, EscrowStatus.CLOSED, EscrowStatus.DISPUTED, EscrowStatus.SETTLING])(
    'refuses to refund a session that is %s',
    async (status) => {
      const { service, refunds } = build({ status });

      await expect(service.refund(ESCROW)).rejects.toBeInstanceOf(ConflictException);
      expect(refunds.save).not.toHaveBeenCalled();
    },
  );

  it('returns the existing refund instead of refunding twice', async () => {
    const { service, rows, emergencyClose } = build({ hub: '0x' + '1'.repeat(40) });

    const first = await service.refund(ESCROW);
    const second = await service.refund(ESCROW);

    expect(second.id).toBe(first.id);
    expect(rows).toHaveLength(1);
    expect(emergencyClose).toHaveBeenCalledTimes(1);
    expect(first.txHash).toBe('0xrefund');
  });

  it('keeps a failed on-chain refund and retries it on the next request', async () => {
    const { service, emergencyClose, escrow, webhooks, rows } = build({ hub: '0x' + '1'.repeat(40) });
    emergencyClose.mockRejectedValueOnce(new Error('nonce too low'));

    const failed = await service.refund(ESCROW);
    expect(failed).toMatchObject({ status: RefundStatus.FAILED, lastError: 'nonce too low' });
    expect(escrow.markRefunded).not.toHaveBeenCalled();
    expect(webhooks.emit).not.toHaveBeenCalled();

    const retried = await service.refund(ESCROW);
    expect(retried).toMatchObject({ status: RefundStatus.COMPLETED, lastError: null });
    expect(rows).toHaveLength(1);
  });

  it('adopts the row of a concurrent request that won the insert', async () => {
    const { service, refunds } = build();
    const winner = { id: 'winner', escrowId: ESCROW, status: RefundStatus.PENDING } as EscrowRefund;
    refunds.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    refunds.save.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));

    expect((await service.refund(ESCROW)).id).toBe('winner');
  });

  it('sweeps: expires due sessions and refunds what is awaiting a refund', async () => {
    const { service, escrow, session } = build();
    escrow.expireDue.mockResolvedValue(3);
    escrow.findAwaitingRefund.mockResolvedValue([session, { id: 'broken' }]);
    escrow.findById.mockResolvedValueOnce(session).mockRejectedValueOnce(new Error('gone'));
    const now = new Date('2026-06-01T00:00:00Z');

    const result = await service.sweep(now);

    expect(escrow.expireDue).toHaveBeenCalledWith(now);
    expect(result).toEqual({ expired: 3, refunded: 1, failed: 1 });
  });
});
