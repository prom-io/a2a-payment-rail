import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** A payer's own daily limit, overriding SPENDING_LIMIT_DAILY_DEFAULT. */
@Entity('spending_limits')
export class SpendingLimit {
  // Lowercased address of the payer (agent A).
  @PrimaryColumn({ type: 'varchar', length: 42 })
  payer!: string;

  // 0 means "not limited", which is how one payer is exempted from the default.
  @Column('decimal', { precision: 36, scale: 18 })
  dailyLimit!: string;

  @UpdateDateColumn()
  updatedAt!: Date;
}
