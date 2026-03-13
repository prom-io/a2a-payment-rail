import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export enum EscrowStatus {
  OPEN = 'open',
  SETTLING = 'settling',
  CLOSED = 'closed',
  DISPUTED = 'disputed',
  EXPIRED = 'expired',
}

@Entity('escrow_sessions')
export class EscrowSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  agentA!: string;

  @Column()
  agentB!: string;

  @Column('decimal', { precision: 36, scale: 18 })
  depositAmount!: string;

  @Column('decimal', { precision: 36, scale: 18 })
  budgetLimit!: string;

  @Column('jsonb', { default: {} })
  policyFlags!: Record<string, unknown>;

  @Column({ default: false })
  verificationRequired!: boolean;

  @Column({
    type: 'enum',
    enum: EscrowStatus,
    default: EscrowStatus.OPEN,
  })
  status!: EscrowStatus;

  @Column('int')
  ttl!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  closedAt!: Date | null;
}
