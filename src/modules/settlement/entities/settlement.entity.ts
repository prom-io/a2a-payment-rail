import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum SettlementStatus {
  PENDING = 'pending',
  SETTLED = 'settled',
  REJECTED = 'rejected',
  RETRYING = 'retrying',
  DEAD_LETTER = 'dead_letter',
}

@Entity('settlements')
// GET /settlements?escrowId=, refund and reconciliation sums per escrow.
@Index('IDX_settlement_escrow_created', ['escrowId', 'createdAt'])
// Retry queue poll: status = retrying AND nextRetryAt <= now, and the dead-letter list.
@Index('IDX_settlement_retry_queue', ['status', 'nextRetryAt'])
// Keyset pagination of the export: ORDER BY createdAt, id.
@Index('IDX_settlement_created_id', ['createdAt', 'id'])
export class Settlement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  escrowId!: string;

  @Column()
  receiptsHash!: string;

  @Column('decimal', { precision: 36, scale: 18 })
  totalAmount!: string;

  // Protocol fee withheld from totalAmount under the fee policy of the chain.
  @Column('decimal', { precision: 36, scale: 18, nullable: true })
  feeAmount!: string | null;

  @Column({
    type: 'enum',
    enum: SettlementStatus,
    default: SettlementStatus.PENDING,
  })
  status!: SettlementStatus;

  // Number of receipts aggregated into this batch; null for hand-submitted batches.
  @Column({ type: 'int', nullable: true })
  receiptCount!: number | null;

  // Compact calldata of the batch. Not selected by default: it is only needed
  // to post or audit the batch, and list queries should not drag it along.
  @Column({ type: 'text', nullable: true, select: false })
  packedReceipts!: string | null;

  // On-chain attempts made so far; reset by a manual replay.
  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'timestamp', nullable: true })
  nextRetryAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  // Hash of the last broadcast transaction, kept even when waiting for it failed.
  @Column({ type: 'varchar', length: 66, nullable: true })
  txHash!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  settledAt!: Date | null;
}
