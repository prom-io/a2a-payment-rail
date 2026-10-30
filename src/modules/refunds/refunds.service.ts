import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { ethers } from 'ethers';
import { Repository } from 'typeorm';
import { Amount } from '../../common/money/amount';
import { ESCROW_HUB_ABI } from '../../common/blockchain/abis/escrow-hub.abi';
import { BlockchainService } from '../../common/blockchain/blockchain.service';
import { EscrowSession, EscrowStatus } from '../escrow/entities/escrow-session.entity';
import { EscrowService } from '../escrow/escrow.service';
import { Settlement, SettlementStatus } from '../settlement/entities/settlement.entity';
import { StreamClaim } from '../streaming/entities/stream-claim.entity';
import { WebhookEvent } from '../webhooks/webhook-events';
import { WebhooksService } from '../webhooks/webhooks.service';
import { EscrowRefund, RefundReason, RefundStatus } from './entities/escrow-refund.entity';

const PG_UNIQUE_VIOLATION = '23505';
const MAX_ERROR_LENGTH = 500;

const REFUNDABLE: Partial<Record<EscrowStatus, RefundReason>> = {
  [EscrowStatus.EXPIRED]: RefundReason.EXPIRED,
  [EscrowStatus.CANCELLED]: RefundReason.CANCELLED,
};

export interface RefundSweepResult {
  expired: number;
  refunded: number;
  failed: number;
}

/**
 * Returns the unspent deposit of escrow sessions that ended without being
 * closed by the payer: sessions past their TTL and sessions that were cancelled.
 *
 *   refund = deposit - settled batches - stream claims - partial releases
 *            (never below zero)
 *
 * One refund row exists per escrow. Requesting a refund again returns that
 * row; if its on-chain transaction failed, the request retries it.
 */
@Injectable()
export class RefundsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RefundsService.name);
  private readonly escrowHubAddress: string;
  private readonly sweepEnabled: boolean;
  private readonly sweepMs: number;
  private readonly sweepBatch: number;
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    @InjectRepository(EscrowRefund)
    private readonly refunds: Repository<EscrowRefund>,
    @InjectRepository(Settlement)
    private readonly settlements: Repository<Settlement>,
    @InjectRepository(StreamClaim)
    private readonly claims: Repository<StreamClaim>,
    private readonly escrowService: EscrowService,
    private readonly blockchainService: BlockchainService,
    private readonly webhooksService: WebhooksService,
    configService: ConfigService,
  ) {
    this.escrowHubAddress = configService.get<string>('ESCROW_HUB_ADDRESS', '');
    this.sweepEnabled = configService.get<boolean>('refunds.sweepEnabled', false);
    this.sweepMs = configService.get<number>('refunds.sweepMs', 60_000);
    this.sweepBatch = configService.get<number>('refunds.sweepBatch', 50);
  }

  onModuleInit(): void {
    if (!this.sweepEnabled) return;
    this.timer = setInterval(() => {
      this.sweep().catch((error: Error) =>
        this.logger.error(`Escrow expiry sweep failed: ${error.message}`),
      );
    }, this.sweepMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async findByEscrowId(escrowId: string): Promise<EscrowRefund> {
    const refund = await this.refunds.findOne({ where: { escrowId } });
    if (!refund) throw new NotFoundException(`No refund for escrow ${escrowId}`);
    return refund;
  }

  async refund(escrowId: string): Promise<EscrowRefund> {
    const session = await this.escrowService.findById(escrowId);
    const reason = REFUNDABLE[session.status];
    if (!reason) {
      throw new ConflictException(
        `Escrow ${escrowId} is ${session.status}; only expired or cancelled sessions are refunded`,
      );
    }

    let refund = await this.refunds.findOne({ where: { escrowId } });
    if (refund?.status === RefundStatus.COMPLETED) return refund;
    if (!refund) refund = await this.create(session, reason);

    return this.execute(refund);
  }

  /** Expires sessions past their TTL, then refunds whatever is refundable and not refunded yet. */
  async sweep(now: Date = new Date()): Promise<RefundSweepResult> {
    const result: RefundSweepResult = { expired: 0, refunded: 0, failed: 0 };
    if (this.sweeping) return result;
    this.sweeping = true;
    try {
      result.expired = await this.escrowService.expireDue(now);
      const pending = await this.escrowService.findAwaitingRefund(this.sweepBatch);
      for (const session of pending) {
        try {
          const refund = await this.refund(session.id);
          if (refund.status === RefundStatus.COMPLETED) result.refunded += 1;
          else result.failed += 1;
        } catch (error) {
          result.failed += 1;
          this.logger.error(`Refund of escrow ${session.id} failed: ${(error as Error).message}`);
        }
      }
      return result;
    } finally {
      this.sweeping = false;
    }
  }

  private async create(session: EscrowSession, reason: RefundReason): Promise<EscrowRefund> {
    const deposit = Amount.from(session.depositAmount).wei;
    const spent =
      (await this.spent(session.id)) + Amount.from(session.releasedAmount ?? '0').wei;
    if (spent > deposit) {
      this.logger.warn(`Escrow ${session.id} spent ${Amount.fromWei(spent).toString()} of a ${Amount.fromWei(deposit).toString()} deposit`);
    }
    try {
      return await this.refunds.save(
        this.refunds.create({
          escrowId: session.id,
          reason,
          depositAmount: Amount.fromWei(deposit).toString(),
          spentAmount: Amount.fromWei(spent).toString(),
          refundAmount: Amount.fromWei(spent > deposit ? 0n : deposit - spent).toString(),
          status: RefundStatus.PENDING,
        }),
      );
    } catch (error: any) {
      // A concurrent request created the row first; continue with that one.
      if ((error?.code ?? error?.driverError?.code) === PG_UNIQUE_VIOLATION) {
        return this.findByEscrowId(session.id);
      }
      throw error;
    }
  }

  /**
   * EscrowHub.emergencyClose pays `deposit - spent` back to the payer. The
   * payer-only closeEscrow cannot be used here: the rail is not the payer.
   */
  private async execute(refund: EscrowRefund): Promise<EscrowRefund> {
    try {
      if (this.escrowHubAddress) {
        const contract = this.blockchainService.getContract(this.escrowHubAddress, ESCROW_HUB_ABI);
        const tx = await contract.emergencyClose(
          ethers.keccak256(ethers.toUtf8Bytes(refund.escrowId)),
        );
        refund.txHash = tx.hash;
        await tx.wait();
      }
      refund.status = RefundStatus.COMPLETED;
      refund.completedAt = new Date();
      refund.lastError = null;
    } catch (error: any) {
      refund.status = RefundStatus.FAILED;
      refund.lastError = String(error?.message ?? error).slice(0, MAX_ERROR_LENGTH);
      this.logger.error(`On-chain refund of escrow ${refund.escrowId} failed: ${refund.lastError}`);
    }
    const saved = await this.refunds.save(refund);
    if (saved.status === RefundStatus.COMPLETED) {
      await this.escrowService.markRefunded(saved.escrowId);
      void this.webhooksService.emit(WebhookEvent.ESCROW_REFUNDED, {
        escrowId: saved.escrowId,
        reason: saved.reason,
        depositAmount: saved.depositAmount,
        spentAmount: saved.spentAmount,
        refundAmount: saved.refundAmount,
        txHash: saved.txHash,
      });
    }
    return saved;
  }

  private async spent(escrowId: string): Promise<bigint> {
    const settled = await this.settlements
      .createQueryBuilder('settlement')
      .select('COALESCE(SUM(settlement.totalAmount), 0)', 'total')
      .where('settlement.escrowId = :escrowId', { escrowId })
      .andWhere('settlement.status = :status', { status: SettlementStatus.SETTLED })
      .getRawOne<{ total: string }>();
    const claimed = await this.claims
      .createQueryBuilder('claim')
      .select('COALESCE(SUM(claim.usageDelta), 0)', 'total')
      .where('claim.escrowId = :escrowId', { escrowId })
      .getRawOne<{ total: string }>();
    return Amount.from(settled?.total ?? '0').wei + Amount.from(claimed?.total ?? '0').wei;
  }
}
