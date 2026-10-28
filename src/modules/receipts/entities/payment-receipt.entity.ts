import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

// Index names are explicit so schema sync matches them by name and a rename of
// a property does not silently drop and rebuild an index.
@Entity('payment_receipts')
// GET /receipts/:escrowId and findByEscrowIds: filter by escrow, read in creation order.
@Index('IDX_receipt_escrow_created', ['escrowId', 'createdAt'])
// Inclusion proofs: all receipts of one batch in leaf order.
@Index('IDX_receipt_settlement_batch', ['settlementId', 'batchIndex'])
// Batch scheduler scan. Partial: it only ever holds the unsettled backlog, so it
// stays small however many settled receipts pile up.
@Index('IDX_receipt_unsettled', ['createdAt', 'id'], { where: '"settlementId" IS NULL' })
// Proof and validation lookups by hash.
@Index('IDX_receipt_hash', ['receiptHash'])
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

  // Position of the receipt inside its batch: the leaf index of its Merkle proof.
  @Column({ type: 'int', nullable: true })
  batchIndex!: number | null;

  @CreateDateColumn()
  createdAt!: Date;
}
