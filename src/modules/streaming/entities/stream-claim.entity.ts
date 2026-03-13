import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('stream_claims')
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
