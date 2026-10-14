import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { WebhookEvent } from '../webhook-events';

export enum WebhookDeliveryStatus {
  PENDING = 'pending',
  DELIVERED = 'delivered',
  FAILED = 'failed',
}

/** One event for one subscription, with the outcome of sending it. */
@Entity('webhook_deliveries')
@Index('IDX_webhook_delivery_subscription', ['subscriptionId', 'createdAt'])
export class WebhookDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  subscriptionId!: string;

  @Column({ type: 'varchar', length: 64 })
  event!: WebhookEvent;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16, default: WebhookDeliveryStatus.PENDING })
  status!: WebhookDeliveryStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  // HTTP status of the last attempt; null when the request never got an answer.
  @Column({ type: 'int', nullable: true })
  responseStatus!: number | null;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  deliveredAt!: Date | null;
}
