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

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  settledAt!: Date | null;
}
