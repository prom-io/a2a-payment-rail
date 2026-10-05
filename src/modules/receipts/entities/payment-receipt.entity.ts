import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('payment_receipts')
export class PaymentReceipt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  escrowId!: string;

  @Column()
  sessionId!: string;

  @Column()
  fromAgent!: string;

  @Column()
  toAgent!: string;

  @Column('decimal', { precision: 36, scale: 18 })
  amount!: string;

  @Column()
  receiptHash!: string;

  @Column()
  signature!: string;

  // Settlement this receipt was batched into; null while it waits for a batch.
  @Column({ type: 'uuid', nullable: true })
  settlementId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
