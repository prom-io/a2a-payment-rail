import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { EscrowSession, EscrowStatus } from './entities/escrow-session.entity';
import { SpendingLimit } from './entities/spending-limit.entity';
import { Amount } from '../../common/money/amount';

// First key of the two-int advisory lock; the second one is hashtext(payer).
const SPENDING_LOCK_NAMESPACE = 7002;

export interface SpendingStatus {
  payer: string;
  /** null when the payer is not limited. */
  dailyLimit: string | null;
  source: 'override' | 'default' | 'none';
  windowHours: number;
  windowStart: string;
  spent: string;
  /** null when the payer is not limited. */
  remaining: string | null;
}

/**
 * Caps how much a payer may lock into escrow per rolling window.
 *
 * "Spent" is the sum of deposits of the sessions the payer opened in the last
 * `windowHours` (24 by default), cancelled sessions excluded. The window rolls:
 * it is always measured back from now, not reset at midnight, so a payer
 * cannot spend the limit at 23:59 and again at 00:01.
 *
 * The limit of a payer is its row in `spending_limits` or, without one, the
 * default from SPENDING_LIMIT_DAILY_DEFAULT; an empty or zero default means
 * unlimited.
 */
@Injectable()
export class SpendingLimitService {
  private readonly logger = new Logger(SpendingLimitService.name);
  private readonly defaultLimit: bigint | null;
  private readonly windowHours: number;

  constructor(
    @InjectRepository(SpendingLimit)
    private readonly limits: Repository<SpendingLimit>,
    @InjectRepository(EscrowSession)
    private readonly sessions: Repository<EscrowSession>,
    configService: ConfigService,
  ) {
    const raw = String(configService.get('SPENDING_LIMIT_DAILY_DEFAULT', '') ?? '').trim();
    if (raw !== '' && (!Amount.isValid(raw) || Amount.from(raw).isNegative())) {
      throw new Error(`SPENDING_LIMIT_DAILY_DEFAULT must be a decimal amount, got "${raw}"`);
    }
    const parsed = raw === '' ? 0n : Amount.from(raw).wei;
    this.defaultLimit = parsed > 0n ? parsed : null;
    const hours = Number(configService.get('SPENDING_LIMIT_WINDOW_HOURS', 24));
    this.windowHours = Number.isFinite(hours) && hours > 0 ? hours : 24;
  }

  /**
   * Runs `insert` only if `amount` still fits into the payer's window. Check
   * and insert share one transaction and a per-payer advisory lock, so two
   * concurrent opens cannot both squeeze under the limit.
   */
  async withinLimit<T>(
    payer: string,
    amount: string,
    insert: (manager: EntityManager) => Promise<T>,
    now: Date = new Date(),
  ): Promise<T> {
    const address = payer.toLowerCase();
    const { limit } = await this.limitFor(address);
    if (limit === null) return insert(this.sessions.manager);

    return this.sessions.manager.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        SPENDING_LOCK_NAMESPACE,
        address,
      ]);
      const spent = await this.spentInWindow(address, now, manager);
      const requested = Amount.from(amount).wei;
      if (spent + requested > limit) {
        const remaining = limit > spent ? limit - spent : 0n;
        this.logger.warn(
          `Payer ${address} over spending limit: requested ${amount}, remaining ${Amount.fromWei(remaining).toString()}`,
        );
        throw new ForbiddenException(
          `Spending limit exceeded: ${Amount.fromWei(limit).toString()} per ${this.windowHours}h, ` +
            `${Amount.fromWei(spent).toString()} already spent, ${Amount.fromWei(remaining).toString()} remaining`,
        );
      }
      return insert(manager);
    });
  }

  async status(payer: string, now: Date = new Date()): Promise<SpendingStatus> {
    const address = payer.toLowerCase();
    const { limit, source } = await this.limitFor(address);
    const spent = await this.spentInWindow(address, now, this.sessions.manager);
    return {
      payer: address,
      dailyLimit: limit === null ? null : Amount.fromWei(limit).toString(),
      source,
      windowHours: this.windowHours,
      windowStart: this.windowStart(now).toISOString(),
      spent: Amount.fromWei(spent).toString(),
      remaining: limit === null ? null : Amount.fromWei(limit > spent ? limit - spent : 0n).toString(),
    };
  }

  /** Sets the payer's own limit; "0" lifts the limit for this payer only. */
  async setLimit(payer: string, dailyLimit: string): Promise<SpendingLimit> {
    return this.limits.save(
      this.limits.create({ payer: payer.toLowerCase(), dailyLimit: Amount.fromWei(Amount.from(dailyLimit).wei).toString() }),
    );
  }

  /** Removes the payer's own limit; the default applies again. */
  async clearLimit(payer: string): Promise<void> {
    await this.limits.delete({ payer: payer.toLowerCase() });
  }

  private async limitFor(
    address: string,
  ): Promise<{ limit: bigint | null; source: SpendingStatus['source'] }> {
    const override = await this.limits.findOne({ where: { payer: address } });
    if (override) {
      const limit = Amount.from(override.dailyLimit).wei;
      return { limit: limit > 0n ? limit : null, source: 'override' };
    }
    return { limit: this.defaultLimit, source: this.defaultLimit === null ? 'none' : 'default' };
  }

  private windowStart(now: Date): Date {
    return new Date(now.getTime() - this.windowHours * 3_600_000);
  }

  private async spentInWindow(address: string, now: Date, manager: EntityManager): Promise<bigint> {
    const row = await manager
      .createQueryBuilder(EscrowSession, 'session')
      .select('COALESCE(SUM(session.depositAmount), 0)', 'total')
      .where('LOWER(session.agentA) = :address', { address })
      .andWhere('session.createdAt > :since', { since: this.windowStart(now) })
      .andWhere('session.status != :cancelled', { cancelled: EscrowStatus.CANCELLED })
      .getRawOne<{ total: string }>();
    return Amount.from(row?.total ?? '0').wei;
  }
}
