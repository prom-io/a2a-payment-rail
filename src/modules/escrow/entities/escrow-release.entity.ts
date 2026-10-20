import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum ReleaseStatus {
  COMPLETED = 'completed',
  // The on-chain payout failed and the amount was returned to the session.
  FAILED = 'failed',
}

/** One partial release of an escrow session. Rows are kept for audit, failed ones included. */
@Entity('escrow_releases')
@Index('IDX_escrow_release_escrow', ['escrowId', 'createdAt'])
export class EscrowRelease {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  escrowId!: string;

  @Column('decimal', { precision: 36, scale: 18 })
  amount!: string;

  @Column({ type: 'varchar', length: 16, default: ReleaseStatus.COMPLETED })
  status!: ReleaseStatus;

  @Column({ type: 'varchar', length: 256, nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', length: 66, nullable: true })
  txHash!: string | null;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
