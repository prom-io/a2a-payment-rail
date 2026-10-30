import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { WithdrawFeesDto } from './dto/withdraw-fees.dto';
import { FeeLedgerEntry, FeeLedgerEntryType } from './entities/fee-ledger-entry.entity';
import { FeePolicyService } from './fee-policy.service';
import { Amount } from '../../common/money/amount';

const PG_UNIQUE_VIOLATION = '23505';
// First key of the two-int advisory lock; the second one is the chain id.
const WITHDRAWAL_LOCK_NAMESPACE = 7001;

export interface FeeBalance {
  chainId: number;
  accrued: string;
  withdrawn: string;
  available: string;
}

interface Totals {
  accrued: bigint;
  withdrawn: bigint;
}

/**
 * Protocol fee accounting.
 *
 * Fees are accrued when a settlement is settled and leave the ledger through
 * withdrawals. The ledger is the rail's own book: EscrowHub keeps withheld
 * fees in the contract balance and has no payout function of its own, so a
 * withdrawal records the treasury payout (with its transaction hash once
 * known) and guarantees that no more than the accrued balance is paid out.
 */
@Injectable()
export class FeeLedgerService {
  private readonly logger = new Logger(FeeLedgerService.name);

  constructor(
    @InjectRepository(FeeLedgerEntry)
    private readonly entries: Repository<FeeLedgerEntry>,
    private readonly feePolicyService: FeePolicyService,
  ) {}

  /** Books the fee of a settled settlement. Safe to call more than once. */
  async accrue(
    settlement: { id: string; feeAmount: string | null },
    chainId: number = this.feePolicyService.chainId,
  ): Promise<FeeLedgerEntry | null> {
    if (!settlement.feeAmount || Amount.from(settlement.feeAmount).wei === 0n) return null;
    try {
      return await this.entries.save(
        this.entries.create({
          chainId: String(chainId),
          type: FeeLedgerEntryType.ACCRUAL,
          amount: settlement.feeAmount,
          settlementId: settlement.id,
        }),
      );
    } catch (error: any) {
      if ((error?.code ?? error?.driverError?.code) === PG_UNIQUE_VIOLATION) return null;
      throw error;
    }
  }

  async balance(chainId: number = this.feePolicyService.chainId): Promise<FeeBalance> {
    return toBalance(chainId, await this.totals(this.entries.manager, chainId));
  }

  async recentEntries(chainId: number = this.feePolicyService.chainId, limit = 50) {
    return this.entries.find({
      where: { chainId: String(chainId) },
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  async withdraw(dto: WithdrawFeesDto): Promise<{ entry: FeeLedgerEntry; balance: FeeBalance }> {
    const chainId = dto.chainId ?? this.feePolicyService.chainId;
    const amount = Amount.from(dto.amount).wei;
    if (amount <= 0n) throw new BadRequestException('amount must be greater than zero');

    return this.entries.manager.transaction(async (manager) => {
      // Serialises withdrawals of one chain across instances: without the lock
      // two concurrent requests would both see the same available balance.
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [
        WITHDRAWAL_LOCK_NAMESPACE,
        chainId % 2 ** 31,
      ]);

      const totals = await this.totals(manager, chainId);
      const available = totals.accrued - totals.withdrawn;
      if (amount > available) {
        throw new ConflictException(
          `Insufficient accrued fees on chain ${chainId}: requested ${dto.amount}, ` +
            `available ${Amount.fromWei(available).toString()}`,
        );
      }

      const entry = await manager.save(
        manager.create(FeeLedgerEntry, {
          chainId: String(chainId),
          type: FeeLedgerEntryType.WITHDRAWAL,
          amount: Amount.fromWei(amount).toString(),
          recipient: dto.recipient.toLowerCase(),
          txHash: dto.txHash ?? null,
          note: dto.note ?? null,
        }),
      );
      this.logger.warn(
        `Fee withdrawal ${entry.id}: ${entry.amount} on chain ${chainId} to ${entry.recipient}`,
      );
      return {
        entry,
        balance: toBalance(chainId, { ...totals, withdrawn: totals.withdrawn + amount }),
      };
    });
  }

  private async totals(manager: EntityManager, chainId: number): Promise<Totals> {
    const rows = await manager
      .createQueryBuilder(FeeLedgerEntry, 'entry')
      .select('entry.type', 'type')
      .addSelect('COALESCE(SUM(entry.amount), 0)', 'total')
      .where('entry.chainId = :chainId', { chainId: String(chainId) })
      .groupBy('entry.type')
      .getRawMany<{ type: FeeLedgerEntryType; total: string }>();

    const totalOf = (type: FeeLedgerEntryType): bigint =>
      Amount.from(rows.find((row) => row.type === type)?.total ?? '0').wei;
    return {
      accrued: totalOf(FeeLedgerEntryType.ACCRUAL),
      withdrawn: totalOf(FeeLedgerEntryType.WITHDRAWAL),
    };
  }
}

function toBalance(chainId: number, totals: Totals): FeeBalance {
  return {
    chainId,
    accrued: Amount.fromWei(totals.accrued).toString(),
    withdrawn: Amount.fromWei(totals.withdrawn).toString(),
    available: Amount.fromWei(totals.accrued - totals.withdrawn).toString(),
  };
}
