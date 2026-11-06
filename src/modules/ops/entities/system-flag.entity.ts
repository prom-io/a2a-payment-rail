import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Small operator-controlled switches that every instance must agree on. */
@Entity('system_flags')
export class SystemFlag {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  key!: string;

  @Column({ type: 'jsonb' })
  value!: Record<string, any>;

  @Column({ type: 'varchar', length: 128, nullable: true })
  updatedBy!: string | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}
