import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export enum SettlementStatus {
  PENDING = 'pending',
  SETTLED = 'settled',
  REJECTED = 'rejected',
  RETRYING = 'retrying',
  DEAD_LETTER = 'dead_letter',
}

@Entity('settlements')
export class Settlement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  escrowId!: string;

  @Column()
  receiptsHash!: string;

  @Column('decimal', { precision: 36, scale: 18 })
  totalAmount!: string;

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
