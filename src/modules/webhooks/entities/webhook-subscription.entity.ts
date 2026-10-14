import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { WebhookEvent } from '../webhook-events';

@Entity('webhook_subscriptions')
export class WebhookSubscription {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 2048 })
  url!: string;

  @Column('simple-array')
  events!: WebhookEvent[];

  // Shared secret of the subscriber. Returned once, on creation, and never again.
  @Column({ type: 'varchar', length: 64 })
  secret!: string;

  @Column({ default: true })
  active!: boolean;

  @Column({ type: 'varchar', length: 256, nullable: true })
  description!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
