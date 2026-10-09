import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum IdempotencyStatus {
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
}

// The unique index is the lock: two requests racing with the same key cannot
// both insert, whichever instance of the service they hit.
@Entity('idempotency_records')
@Index('UQ_idempotency_key_scope', ['key', 'scope'], { unique: true })
export class IdempotencyRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  key!: string;

  // "<METHOD> <path>", so one key cannot be replayed against another route.
  @Column({ type: 'varchar', length: 512 })
  scope!: string;

  // sha256 of the canonical request body.
  @Column({ type: 'varchar', length: 64 })
  requestHash!: string;

  @Column({ type: 'varchar', length: 16, default: IdempotencyStatus.IN_PROGRESS })
  status!: IdempotencyStatus;

  @Column({ type: 'jsonb', nullable: true })
  responseBody!: unknown;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'timestamp' })
  expiresAt!: Date;
}
