import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import { ethers } from 'ethers';
import { Settlement, SettlementStatus } from './entities/settlement.entity';
import { BlockchainService } from '../../common/blockchain/blockchain.service';
import { ESCROW_HUB_ABI } from '../../common/blockchain/abis/escrow-hub.abi';

/** Batch parameters; the amount is a decimal string when it comes from the scheduler. */
export interface SettleBatchInput {
  escrowId: string;
  receiptsHash: string;
  totalAmount: number | string;
  receiptCount?: number;
  /** Compact calldata blob of the batch, see batch-calldata.util.ts. */
  packedReceipts?: string;
}

// A revert is the contract's final answer for this batch: sending the same
// call again burns gas and reverts again.
const NON_RETRYABLE_CODES = new Set(['CALL_EXCEPTION', 'INVALID_ARGUMENT', 'UNSUPPORTED_OPERATION']);
const MAX_ERROR_LENGTH = 500;

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);
  private readonly escrowHubAddress: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(
    @InjectRepository(Settlement)
    private readonly settlementRepo: Repository<Settlement>,
    private readonly blockchainService: BlockchainService,
    private readonly configService: ConfigService,
  ) {
    this.escrowHubAddress = this.configService.get<string>('ESCROW_HUB_ADDRESS', '');
    this.maxAttempts = this.configService.get<number>('settlement.retry.maxAttempts', 5);
    this.baseDelayMs = this.configService.get<number>('settlement.retry.baseDelayMs', 30_000);
    this.maxDelayMs = this.configService.get<number>('settlement.retry.maxDelayMs', 3_600_000);
  }

  async settleBatch(dto: SettleBatchInput): Promise<Settlement> {
    const settlement = this.settlementRepo.create({
      escrowId: dto.escrowId,
      receiptsHash: dto.receiptsHash,
      totalAmount: dto.totalAmount.toString(),
      status: SettlementStatus.PENDING,
      receiptCount: dto.receiptCount ?? null,
      packedReceipts: dto.packedReceipts ?? null,
    });
    const saved = await this.settlementRepo.save(settlement);

    if (this.escrowHubAddress) {
      await this.attempt(saved);
    }
    return saved;
  }

  /**
   * One on-chain attempt. Never throws: the outcome is written to the row.
   *
   *   success             -> settled
   *   revert              -> rejected (final, replay is manual)
   *   transient failure   -> retrying with exponential backoff, and
   *                          dead_letter once the attempts are used up
   */
  async attempt(settlement: Settlement, now: Date = new Date()): Promise<Settlement> {
    settlement.attempts = (settlement.attempts ?? 0) + 1;
    try {
      const earlier = await this.confirmEarlierTransaction(settlement);
      if (earlier === null) {
        // The earlier transaction is still in the mempool. Sending a second one
        // would pay the payee twice, so only wait; this does not use up an attempt.
        settlement.attempts -= 1;
        settlement.status = SettlementStatus.RETRYING;
        settlement.nextRetryAt = new Date(now.getTime() + this.baseDelayMs);
        return await this.settlementRepo.save(settlement);
      }
      const hash = earlier ?? (await this.send(settlement));
      settlement.status = SettlementStatus.SETTLED;
      settlement.settledAt = now;
      settlement.nextRetryAt = null;
      settlement.lastError = null;
      this.logger.log(
        `Settlement ${settlement.id} for escrow ${settlement.escrowId} completed, tx: ${hash}`,
      );
    } catch (error: any) {
      settlement.lastError = String(error?.message ?? error).slice(0, MAX_ERROR_LENGTH);
      settlement.nextRetryAt = null;
      if (NON_RETRYABLE_CODES.has(error?.code)) {
        settlement.status = SettlementStatus.REJECTED;
      } else if (settlement.attempts >= this.maxAttempts) {
        settlement.status = SettlementStatus.DEAD_LETTER;
      } else {
        settlement.status = SettlementStatus.RETRYING;
        settlement.nextRetryAt = new Date(now.getTime() + this.backoffMs(settlement.attempts));
      }
      this.logger.error(
        `On-chain settlement ${settlement.id} failed (attempt ${settlement.attempts}/${this.maxAttempts}, ` +
          `now ${settlement.status}): ${settlement.lastError}`,
      );
    }
    return this.settlementRepo.save(settlement);
  }

  /** Delay before the next attempt: base, 2x base, 4x base ... capped at maxDelayMs. */
  backoffMs(attempts: number): number {
    const exponent = Math.min(Math.max(attempts - 1, 0), 30);
    return Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
  }

  async findDueRetries(now: Date, limit: number): Promise<Settlement[]> {
    return this.settlementRepo.find({
      where: { status: SettlementStatus.RETRYING, nextRetryAt: LessThanOrEqual(now) },
      order: { nextRetryAt: 'ASC' },
      take: limit,
    });
  }

  /** Settlements that will not move again without an operator. */
  async findDeadLetters(): Promise<Settlement[]> {
    return this.settlementRepo.find({
      where: { status: In([SettlementStatus.DEAD_LETTER, SettlementStatus.REJECTED]) },
      order: { createdAt: 'ASC' },
    });
  }

  /** Operator action: give a dead-lettered or rejected settlement a fresh set of attempts. */
  async replay(id: string): Promise<Settlement> {
    const settlement = await this.findById(id);
    if (
      settlement.status !== SettlementStatus.DEAD_LETTER &&
      settlement.status !== SettlementStatus.REJECTED
    ) {
      throw new ConflictException(
        `Settlement ${id} is ${settlement.status}; only dead_letter or rejected can be replayed`,
      );
    }
    if (!this.escrowHubAddress) {
      throw new ConflictException('ESCROW_HUB_ADDRESS is not configured; nothing to replay against');
    }
    settlement.attempts = 0;
    this.logger.warn(`Manual replay of settlement ${id} (last error: ${settlement.lastError})`);
    return this.attempt(settlement);
  }

  async findById(id: string): Promise<Settlement> {
    const settlement = await this.settlementRepo.findOne({ where: { id } });
    if (!settlement) throw new NotFoundException(`Settlement ${id} not found`);
    return settlement;
  }

  async findByEscrowId(escrowId: string): Promise<Settlement[]> {
    return this.settlementRepo.find({ where: { escrowId } });
  }

  async findLatestByEscrowIds(escrowIds: string[]): Promise<Record<string, Settlement>> {
    if (escrowIds.length === 0) return {};
    const settlements = await this.settlementRepo.find({
      where: { escrowId: In(escrowIds) },
      order: { settledAt: 'DESC', createdAt: 'DESC' },
    });
    return settlements.reduce<Record<string, Settlement>>((acc, item) => {
      if (!acc[item.escrowId]) {
        acc[item.escrowId] = item;
      }
      return acc;
    }, {});
  }

  /**
   * A previous attempt may have broadcast a transaction and then lost the
   * connection while waiting for it. Returns the hash if it was mined, null if
   * it is still pending, undefined if there is nothing to wait for.
   */
  private async confirmEarlierTransaction(
    settlement: Settlement,
  ): Promise<string | null | undefined> {
    if (!settlement.txHash) return undefined;
    const provider = this.blockchainService.getProvider();
    const receipt = await provider.getTransactionReceipt(settlement.txHash);
    if (receipt?.status === 1) return settlement.txHash;
    if (receipt) return undefined; // mined and reverted: safe to send again
    return (await provider.getTransaction(settlement.txHash)) ? null : undefined;
  }

  private async send(settlement: Settlement): Promise<string> {
    const contract = this.blockchainService.getContract(this.escrowHubAddress, ESCROW_HUB_ABI);
    const escrowIdHash = ethers.keccak256(ethers.toUtf8Bytes(settlement.escrowId));
    const receiptsHashBytes = ethers.keccak256(ethers.toUtf8Bytes(settlement.receiptsHash));
    const amountWei = ethers.parseEther(settlement.totalAmount);
    const tx = await contract.settleBatch(escrowIdHash, receiptsHashBytes, amountWei);
    // Persist the hash before waiting: if the wait fails, the retry can tell a
    // mined transaction from a lost one instead of paying twice.
    settlement.txHash = tx.hash;
    await this.settlementRepo.save(settlement);
    const receipt = await tx.wait();
    return receipt.hash;
  }
}
