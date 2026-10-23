import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum ReconciliationStatus {
  OK = 'ok',
  MISMATCH = 'mismatch',
  // Nothing to compare against (no hub configured) or a run was already in flight.
  SKIPPED = 'skipped',
  // The comparison could not be completed, typically because the RPC failed.
  FAILED = 'failed',
}

export interface ReconciliationMismatch {
  /** null for hub-wide findings. */
  escrowId: string | null;
  kind:
    | 'missing_on_chain'
    | 'inactive_on_chain'
    | 'deposit_mismatch'
    | 'spent_mismatch'
    | 'hub_balance_shortfall';
  ledger: string;
  onChain: string;
}

@Entity('reconciliation_runs')
export class ReconciliationRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: ReconciliationStatus;

  // Open sessions compared in this run.
  @Column({ type: 'int', default: 0 })
  checked!: number;

  @Column({ type: 'int', default: 0 })
  mismatches!: number;

  // At most the first 100 mismatches; `mismatches` has the real count.
  @Column({ type: 'jsonb', default: [] })
  details!: ReconciliationMismatch[];

  // sum(deposit - spent) over the checked sessions, per the ledger.
  @Column('decimal', { precision: 36, scale: 18, nullable: true })
  ledgerLocked!: string | null;

  // Native balance of the hub contract.
  @Column('decimal', { precision: 36, scale: 18, nullable: true })
  onChainBalance!: string | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Index('IDX_reconciliation_run_started')
  @Column({ type: 'timestamp' })
  startedAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  finishedAt!: Date;
}
