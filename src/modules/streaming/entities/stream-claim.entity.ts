import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('stream_claims')
// Latest claim of an escrow (every new claim reads it) and the per-escrow sums.
@Index('IDX_stream_claim_escrow_claimed', ['escrowId', 'claimedAt'])
export class StreamClaim {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  escrowId!: string;

  @Column('decimal', { precision: 36, scale: 18 })
  usageDelta!: string;

  @Column('decimal', { precision: 36, scale: 18 })
  cumulativeAmount!: string;

  @CreateDateColumn()
  claimedAt!: Date;
}
