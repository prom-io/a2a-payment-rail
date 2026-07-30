import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Gauge } from 'prom-client';
import { Repository } from 'typeorm';
import { EscrowSession, EscrowStatus } from '../escrow/entities/escrow-session.entity';
import { StreamClaim } from '../streaming/entities/stream-claim.entity';
import { MetricsService } from './metrics.service';

/**
 * Escrow and streaming gauges, scraped straight from the database.
 *
 * These are collected lazily on each /metrics scrape rather than incremented at
 * write time: counters drift whenever a settlement lands out of band (a manual
 * replay, a chain reorg), and a gauge read from the source of truth cannot.
 * The `chain` label keeps the series separable once the rail runs multi-chain.
 */
@Injectable()
export class BusinessMetricsService implements OnModuleInit {
  private readonly logger = new Logger(BusinessMetricsService.name);
  private readonly chain = process.env.CHAIN_ID ?? '31337';

  constructor(
    private readonly metrics: MetricsService,
    @InjectRepository(EscrowSession)
    private readonly escrowRepository: Repository<EscrowSession>,
    @InjectRepository(StreamClaim)
    private readonly streamRepository: Repository<StreamClaim>,
  ) {}

  onModuleInit(): void {
    const self = this;

    new Gauge({
      name: 'payment_rail_escrow_sessions',
      help: 'Escrow sessions by status',
      labelNames: ['chain', 'status'] as const,
      registers: [this.metrics.registry],
      async collect() {
        const counts = await self.countEscrowsByStatus();
        for (const status of Object.values(EscrowStatus)) {
          this.set({ chain: self.chain, status }, counts[status] ?? 0);
        }
      },
    });

    new Gauge({
      name: 'payment_rail_escrow_deposit_total',
      help: 'Sum of deposits held in open escrow sessions',
      labelNames: ['chain'] as const,
      registers: [this.metrics.registry],
      async collect() {
        this.set({ chain: self.chain }, await self.sumOpenDeposits());
      },
    });

    new Gauge({
      name: 'payment_rail_stream_claims_active',
      help: 'Stream claims belonging to escrow sessions that are still open',
      labelNames: ['chain'] as const,
      registers: [this.metrics.registry],
      async collect() {
        this.set({ chain: self.chain }, await self.countActiveStreamClaims());
      },
    });
  }

  private async countEscrowsByStatus(): Promise<Record<string, number>> {
    try {
      const rows = await this.escrowRepository
        .createQueryBuilder('escrow')
        .select('escrow.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('escrow.status')
        .getRawMany<{ status: string; count: string }>();

      return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
    } catch (error) {
      this.logger.warn(`escrow status gauge unavailable: ${(error as Error).message}`);
      return {};
    }
  }

  private async sumOpenDeposits(): Promise<number> {
    try {
      const row = await this.escrowRepository
        .createQueryBuilder('escrow')
        .select('COALESCE(SUM(escrow.depositAmount), 0)', 'total')
        .where('escrow.status = :status', { status: EscrowStatus.OPEN })
        .getRawOne<{ total: string }>();

      return Number(row?.total ?? 0);
    } catch (error) {
      this.logger.warn(`escrow deposit gauge unavailable: ${(error as Error).message}`);
      return 0;
    }
  }

  private async countActiveStreamClaims(): Promise<number> {
    try {
      return await this.streamRepository
        .createQueryBuilder('claim')
        .innerJoin(
          EscrowSession,
          'escrow',
          'escrow.id::text = claim.escrowId AND escrow.status = :status',
          { status: EscrowStatus.OPEN },
        )
        .getCount();
    } catch (error) {
      this.logger.warn(`stream claim gauge unavailable: ${(error as Error).message}`);
      return 0;
    }
  }
}
