import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { ethers } from 'ethers';
import { Gauge } from 'prom-client';
import { In, Repository } from 'typeorm';
import { Amount } from '../../common/money/amount';
import { ESCROW_HUB_ABI } from '../../common/blockchain/abis/escrow-hub.abi';
import { BlockchainService } from '../../common/blockchain/blockchain.service';
import { EscrowSession, EscrowStatus } from '../escrow/entities/escrow-session.entity';
import { MetricsService } from '../metrics/metrics.service';
import { Settlement, SettlementStatus } from '../settlement/entities/settlement.entity';
import {
  ReconciliationMismatch,
  ReconciliationRun,
  ReconciliationStatus,
} from './entities/reconciliation-run.entity';

const MAX_STORED_MISMATCHES = 100;

/**
 * Compares the rail's ledger with EscrowHub.
 *
 * Per open session (oldest first, up to the batch size):
 *   - the hub knows the escrow and still has it active;
 *   - hub deposit  == ledger deposit;
 *   - hub spent    == settled settlements + partial releases.
 * Across the hub, when every open session was checked:
 *   - native balance of the hub >= sum(deposit - spent) of the open sessions.
 *     ">=" because the hub also holds withheld protocol fees.
 *
 * The job only reports. It never changes the ledger or sends a transaction:
 * a mismatch is a question for a human, not something to auto-correct.
 */
@Injectable()
export class ReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationService.name);
  private readonly escrowHubAddress: string;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly mismatchGauge: Gauge;
  private readonly lastRunGauge: Gauge;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectRepository(ReconciliationRun)
    private readonly runs: Repository<ReconciliationRun>,
    @InjectRepository(EscrowSession)
    private readonly sessions: Repository<EscrowSession>,
    @InjectRepository(Settlement)
    private readonly settlements: Repository<Settlement>,
    private readonly blockchainService: BlockchainService,
    metrics: MetricsService,
    configService: ConfigService,
  ) {
    this.escrowHubAddress = configService.get<string>('ESCROW_HUB_ADDRESS', '');
    this.intervalMs = configService.get<number>('reconciliation.intervalMs', 0);
    this.batchSize = configService.get<number>('reconciliation.batchSize', 200);
    this.mismatchGauge = new Gauge({
      name: 'payment_rail_reconciliation_mismatches',
      help: 'Ledger vs on-chain mismatches found by the last reconciliation run',
      registers: [metrics.registry],
    });
    this.lastRunGauge = new Gauge({
      name: 'payment_rail_reconciliation_last_run_timestamp_seconds',
      help: 'Unix time of the last finished reconciliation run',
      registers: [metrics.registry],
    });
  }

  onModuleInit(): void {
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      this.run().catch((error: Error) =>
        this.logger.error(`Reconciliation run failed: ${error.message}`),
      );
    }, this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async latest(): Promise<ReconciliationRun> {
    const [run] = await this.runs.find({ order: { startedAt: 'DESC' }, take: 1 });
    if (!run) throw new NotFoundException('No reconciliation run yet');
    return run;
  }

  async list(limit = 20): Promise<ReconciliationRun[]> {
    return this.runs.find({
      order: { startedAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  async run(now: Date = new Date()): Promise<ReconciliationRun> {
    const run = this.runs.create({
      status: ReconciliationStatus.OK,
      checked: 0,
      mismatches: 0,
      details: [],
      startedAt: now,
    });
    if (this.running) return this.finish(run, ReconciliationStatus.SKIPPED, 'previous run still in progress');
    if (!this.escrowHubAddress) {
      return this.finish(run, ReconciliationStatus.SKIPPED, 'ESCROW_HUB_ADDRESS is not configured');
    }

    this.running = true;
    try {
      const mismatches = await this.compare(run);
      run.mismatches = mismatches.length;
      run.details = mismatches.slice(0, MAX_STORED_MISMATCHES);
      return await this.finish(
        run,
        mismatches.length === 0 ? ReconciliationStatus.OK : ReconciliationStatus.MISMATCH,
      );
    } catch (error) {
      // An unreachable RPC is not a mismatch; keep the two apart for alerting.
      return await this.finish(run, ReconciliationStatus.FAILED, (error as Error).message);
    } finally {
      this.running = false;
    }
  }

  private async compare(run: ReconciliationRun): Promise<ReconciliationMismatch[]> {
    const [open, totalOpen] = await this.sessions.findAndCount({
      where: { status: EscrowStatus.OPEN },
      order: { createdAt: 'ASC' },
      take: this.batchSize,
    });
    const settled = await this.settledByEscrow(open.map((session) => session.id));
    const contract = this.blockchainService.getContract(this.escrowHubAddress, ESCROW_HUB_ABI);
    const mismatches: ReconciliationMismatch[] = [];
    let locked = 0n;

    for (const session of open) {
      const deposit = Amount.from(session.depositAmount).wei;
      const spent = (settled.get(session.id) ?? 0n) + Amount.from(session.releasedAmount ?? '0').wei;
      locked += deposit > spent ? deposit - spent : 0n;

      const onChain = await contract.escrows(ethers.keccak256(ethers.toUtf8Bytes(session.id)));
      const report = (kind: ReconciliationMismatch['kind'], ledger: bigint, chain: bigint) =>
        mismatches.push({ escrowId: session.id, kind, ledger: Amount.fromWei(ledger).toString(), onChain: Amount.fromWei(chain).toString() });

      if (BigInt(onChain.createdAt) === 0n) {
        report('missing_on_chain', deposit, 0n);
        continue;
      }
      if (!onChain.active) report('inactive_on_chain', deposit - spent, 0n);
      if (BigInt(onChain.deposit) !== deposit) report('deposit_mismatch', deposit, BigInt(onChain.deposit));
      if (BigInt(onChain.spent) !== spent) report('spent_mismatch', spent, BigInt(onChain.spent));
    }
    run.checked = open.length;
    run.ledgerLocked = Amount.fromWei(locked).toString();

    const balance = await this.blockchainService.getProvider().getBalance(this.escrowHubAddress);
    run.onChainBalance = Amount.fromWei(balance).toString();
    // Only meaningful when no open session was left out of the sum.
    if (totalOpen <= open.length && balance < locked) {
      mismatches.push({
        escrowId: null,
        kind: 'hub_balance_shortfall',
        ledger: Amount.fromWei(locked).toString(),
        onChain: Amount.fromWei(balance).toString(),
      });
    }
    return mismatches;
  }

  private async settledByEscrow(escrowIds: string[]): Promise<Map<string, bigint>> {
    const totals = new Map<string, bigint>();
    if (escrowIds.length === 0) return totals;
    const rows = await this.settlements.find({
      where: { escrowId: In(escrowIds), status: SettlementStatus.SETTLED },
      select: { escrowId: true, totalAmount: true },
    });
    for (const row of rows) {
      totals.set(row.escrowId, (totals.get(row.escrowId) ?? 0n) + Amount.from(row.totalAmount).wei);
    }
    return totals;
  }

  private async finish(
    run: ReconciliationRun,
    status: ReconciliationStatus,
    error: string | null = null,
  ): Promise<ReconciliationRun> {
    run.status = status;
    run.error = error;
    run.finishedAt = new Date();
    const saved = await this.runs.save(run);

    if (status === ReconciliationStatus.OK || status === ReconciliationStatus.MISMATCH) {
      this.mismatchGauge.set(saved.mismatches);
      this.lastRunGauge.set(Math.floor(saved.finishedAt.getTime() / 1000));
    }
    if (status === ReconciliationStatus.MISMATCH) {
      this.logger.error(
        `Reconciliation found ${saved.mismatches} mismatch(es) in ${saved.checked} sessions: ` +
          JSON.stringify(saved.details.slice(0, 5)),
      );
    } else if (status === ReconciliationStatus.FAILED) {
      this.logger.error(`Reconciliation could not complete: ${error}`);
    }
    return saved;
  }
}
