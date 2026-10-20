import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum RefundReason {
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

export enum RefundStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Entity('escrow_refunds')
export class EscrowRefund {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Unique: an escrow is refunded once, however often the refund is requested.
  @Index('UQ_escrow_refund_escrow', { unique: true })
  @Column({ type: 'uuid' })
  escrowId!: string;

  @Column({ type: 'varchar', length: 16 })
  reason!: RefundReason;

  @Column('decimal', { precision: 36, scale: 18 })
  depositAmount!: string;

  // Settled batches, stream claims and partial releases when the refund was computed.
  @Column('decimal', { precision: 36, scale: 18 })
  spentAmount!: string;

  @Column('decimal', { precision: 36, scale: 18 })
  refundAmount!: string;

  @Column({ type: 'varchar', length: 16, default: RefundStatus.PENDING })
  status!: RefundStatus;

  @Column({ type: 'varchar', length: 66, nullable: true })
  txHash!: string | null;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  completedAt!: Date | null;
}
