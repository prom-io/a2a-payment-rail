import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { ethers } from 'ethers';
import { Repository } from 'typeorm';
import { Amount } from '../../common/money/amount';
import { ESCROW_HUB_ABI } from '../../common/blockchain/abis/escrow-hub.abi';
import { BlockchainService } from '../../common/blockchain/blockchain.service';
import { WebhookEvent } from '../webhooks/webhook-events';
import { WebhooksService } from '../webhooks/webhooks.service';
import { ReleaseEscrowDto } from './dto/release-escrow.dto';
import { EscrowRelease, ReleaseStatus } from './entities/escrow-release.entity';
import { EscrowSession, EscrowStatus } from './entities/escrow-session.entity';
import { EscrowService } from './escrow.service';

const MAX_ERROR_LENGTH = 500;

export interface EscrowBalance {
  escrowId: string;
  status: EscrowStatus;
  depositAmount: string;
  budgetLimit: string;
  releasedAmount: string;
  /** What can still be released: min(deposit, budget) - released. */
  remainingBalance: string;
}

/**
 * Partial release: pays part of an open escrow to the payee and keeps the
 * session open with the rest.
 *
 * `escrow_sessions.releasedAmount` is the running total. It is only ever moved
 * by a single conditional UPDATE, so two concurrent releases cannot together
 * take more than the session holds, whichever instance handles them.
 */
@Injectable()
export class EscrowReleaseService {
  private readonly logger = new Logger(EscrowReleaseService.name);
  private readonly escrowHubAddress: string;

  constructor(
    @InjectRepository(EscrowSession)
    private readonly sessions: Repository<EscrowSession>,
    @InjectRepository(EscrowRelease)
    private readonly releases: Repository<EscrowRelease>,
    private readonly escrowService: EscrowService,
    private readonly blockchainService: BlockchainService,
    private readonly webhooksService: WebhooksService,
    configService: ConfigService,
  ) {
    this.escrowHubAddress = configService.get<string>('ESCROW_HUB_ADDRESS', '');
  }

  async balance(escrowId: string): Promise<EscrowBalance> {
    return toBalance(await this.escrowService.findById(escrowId));
  }

  async findReleases(escrowId: string): Promise<EscrowRelease[]> {
    await this.escrowService.findById(escrowId);
    return this.releases.find({ where: { escrowId }, order: { createdAt: 'ASC' } });
  }

  async release(
    escrowId: string,
    dto: ReleaseEscrowDto,
  ): Promise<{ release: EscrowRelease; balance: EscrowBalance }> {
    const amount = Amount.from(dto.amount).wei;
    if (amount <= 0n) throw new BadRequestException('amount must be greater than zero');

    if (!(await this.reserve(escrowId, dto.amount))) {
      // Nothing was changed; find out why so the caller gets a useful answer.
      const session = await this.escrowService.findById(escrowId);
      if (session.status !== EscrowStatus.OPEN) {
        throw new ConflictException(`Escrow ${escrowId} is ${session.status}; only an open session can release funds`);
      }
      throw new ConflictException(
        `Release of ${dto.amount} exceeds the remaining balance ${toBalance(session).remainingBalance}`,
      );
    }

    let release = await this.releases.save(
      this.releases.create({
        escrowId,
        amount: dto.amount,
        note: dto.note ?? null,
        status: ReleaseStatus.COMPLETED,
      }),
    );

    if (this.escrowHubAddress) {
      try {
        release.txHash = await this.payOut(release, amount);
      } catch (error: any) {
        // The payee was not paid: give the amount back to the session.
        await this.reserve(escrowId, `-${dto.amount}`);
        release.status = ReleaseStatus.FAILED;
        release.lastError = String(error?.message ?? error).slice(0, MAX_ERROR_LENGTH);
        await this.releases.save(release);
        this.logger.error(`On-chain release ${release.id} failed: ${release.lastError}`);
        throw new BadGatewayException(`On-chain release failed: ${release.lastError}`);
      }
      release = await this.releases.save(release);
    }

    const balance = toBalance(await this.escrowService.findById(escrowId));
    void this.webhooksService.emit(WebhookEvent.ESCROW_RELEASED, {
      escrowId,
      releaseId: release.id,
      amount: release.amount,
      releasedAmount: balance.releasedAmount,
      remainingBalance: balance.remainingBalance,
      txHash: release.txHash ?? null,
    });
    return { release, balance };
  }

  /**
   * Adds `delta` (may be negative) to releasedAmount if the session is open and
   * the result stays within [0, min(deposit, budget)]. True when a row changed.
   */
  private async reserve(escrowId: string, delta: string): Promise<boolean> {
    const result = await this.sessions
      .createQueryBuilder()
      .update(EscrowSession)
      .set({ releasedAmount: () => '"releasedAmount" + :delta' })
      .where('id = :escrowId')
      .andWhere('status = :open')
      .andWhere('"releasedAmount" + :delta >= 0')
      .andWhere('"releasedAmount" + :delta <= LEAST("depositAmount", "budgetLimit")')
      .setParameters({ escrowId, delta, open: EscrowStatus.OPEN })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  /**
   * settleBatch is the hub function that pays the payee out of the deposit. The
   * release id stands in for the receipts hash, so the payout is traceable to
   * this release in the BatchSettled event.
   */
  private async payOut(release: EscrowRelease, amount: bigint): Promise<string> {
    const contract = this.blockchainService.getContract(this.escrowHubAddress, ESCROW_HUB_ABI);
    const tx = await contract.settleBatch(
      ethers.keccak256(ethers.toUtf8Bytes(release.escrowId)),
      ethers.keccak256(ethers.toUtf8Bytes(release.id)),
      amount,
    );
    const receipt = await tx.wait();
    return receipt.hash;
  }
}

export function toBalance(session: EscrowSession): EscrowBalance {
  const deposit = Amount.from(session.depositAmount);
  const budget = Amount.from(session.budgetLimit);
  const released = Amount.from(session.releasedAmount ?? '0');
  return {
    escrowId: session.id,
    status: session.status,
    depositAmount: deposit.toString(),
    budgetLimit: budget.toString(),
    releasedAmount: released.toString(),
    remainingBalance: Amount.min(deposit, budget).minusFloored(released).toString(),
  };
}
