import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum FeeLedgerEntryType {
  ACCRUAL = 'accrual',
  WITHDRAWAL = 'withdrawal',
}

/**
 * Append-only ledger of protocol fees. Rows are never updated or deleted: the
 * balance of a chain is the sum of its accruals minus the sum of its
 * withdrawals, so every number can be traced back to the rows behind it.
 */
@Entity('fee_ledger_entries')
@Index('IDX_fee_ledger_chain_type', ['chainId', 'type'])
export class FeeLedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'bigint' })
  chainId!: string;

  @Column({ type: 'varchar', length: 16 })
  type!: FeeLedgerEntryType;

  // Always positive; the type gives the sign.
  @Column('decimal', { precision: 36, scale: 18 })
  amount!: string;

  // Set on accruals. Unique, so a settlement cannot accrue its fee twice.
  @Index('UQ_fee_ledger_settlement', { unique: true })
  @Column({ type: 'uuid', nullable: true })
  settlementId!: string | null;

  // Set on withdrawals.
  @Column({ type: 'varchar', length: 42, nullable: true })
  recipient!: string | null;

  @Column({ type: 'varchar', length: 66, nullable: true })
  txHash!: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  note!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
