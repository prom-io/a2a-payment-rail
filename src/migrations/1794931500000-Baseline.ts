import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Baseline: the schema as schema sync built it before migrations existed,
 * generated from the entities against an empty database.
 *
 * On a database that already has these tables (every environment that ran
 * with schema sync), do not run it: mark it as applied instead, see
 * "Adopting migrations on an existing database" in docs/DATABASE.md.
 */

export class Baseline1794931500000 implements MigrationInterface {
  name = 'Baseline1794931500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Primary keys default to uuid_generate_v4(). TypeORM creates the extension
    // when it connects as a superuser; a service role cannot, so say it here,
    // where it fails loudly and once.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      CREATE TABLE "idempotency_records" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "key" character varying(255) NOT NULL,
        "scope" character varying(512) NOT NULL,
        "requestHash" character varying(64) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'in_progress',
        "responseBody" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "expiresAt" TIMESTAMP NOT NULL,
        CONSTRAINT "PK_9ae4e93699362b0d4e3da3dd1c2" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_idempotency_key_scope" ON "idempotency_records" ("key", "scope")
    `);
    await queryRunner.query(`
      CREATE TABLE "escrow_releases" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "escrowId" uuid NOT NULL,
        "amount" numeric(36, 18) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'completed',
        "note" character varying(256),
        "txHash" character varying(66),
        "lastError" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dc6a2169d2ccdc38660bf547157" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_escrow_release_escrow" ON "escrow_releases" ("escrowId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."escrow_sessions_status_enum" AS ENUM(
        'open',
        'settling',
        'closed',
        'disputed',
        'expired',
        'cancelled'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "escrow_sessions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "agentA" character varying NOT NULL,
        "agentB" character varying NOT NULL,
        "depositAmount" numeric(36, 18) NOT NULL,
        "budgetLimit" numeric(36, 18) NOT NULL,
        "releasedAmount" numeric(36, 18) NOT NULL DEFAULT '0',
        "policyFlags" jsonb NOT NULL DEFAULT '{}',
        "verificationRequired" boolean NOT NULL DEFAULT false,
        "status" "public"."escrow_sessions_status_enum" NOT NULL DEFAULT 'open',
        "ttl" integer NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "closedAt" TIMESTAMP,
        "refundedAt" TIMESTAMP,
        CONSTRAINT "PK_958557e2645ad912939c8763f85" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_escrow_awaiting_refund" ON "escrow_sessions" ("status", "closedAt")
      WHERE "refundedAt" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_escrow_status_created" ON "escrow_sessions" ("status", "createdAt")
    `);
    await queryRunner.query(`
      CREATE TABLE "spending_limits" (
        "payer" character varying(42) NOT NULL,
        "dailyLimit" numeric(36, 18) NOT NULL,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ab09766a29decc9b73ac1db5e37" PRIMARY KEY ("payer")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "fee_ledger_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "chainId" bigint NOT NULL,
        "type" character varying(16) NOT NULL,
        "amount" numeric(36, 18) NOT NULL,
        "settlementId" uuid,
        "recipient" character varying(42),
        "txHash" character varying(66),
        "note" character varying(256),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_bce3442e445b379e298822a83bf" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_fee_ledger_settlement" ON "fee_ledger_entries" ("settlementId")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_fee_ledger_chain_type" ON "fee_ledger_entries" ("chainId", "type")
    `);
    await queryRunner.query(`
      CREATE TABLE "system_flags" (
        "key" character varying(64) NOT NULL,
        "value" jsonb NOT NULL,
        "updatedBy" character varying(128),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_1d6aa97f46c12960bab59932e34" PRIMARY KEY ("key")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "payment_receipts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "escrowId" character varying NOT NULL,
        "sessionId" character varying NOT NULL,
        "fromAgent" character varying NOT NULL,
        "toAgent" character varying NOT NULL,
        "amount" numeric(36, 18) NOT NULL,
        "receiptHash" character varying NOT NULL,
        "signature" character varying NOT NULL,
        "settlementId" uuid,
        "batchIndex" integer,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_42242bb7e01c7d075b35bd13fe0" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_receipt_hash" ON "payment_receipts" ("receiptHash")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_receipt_unsettled" ON "payment_receipts" ("createdAt", "id")
      WHERE "settlementId" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_receipt_settlement_batch" ON "payment_receipts" ("settlementId", "batchIndex")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_receipt_escrow_created" ON "payment_receipts" ("escrowId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE TABLE "reconciliation_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "status" character varying(16) NOT NULL,
        "checked" integer NOT NULL DEFAULT '0',
        "mismatches" integer NOT NULL DEFAULT '0',
        "details" jsonb NOT NULL DEFAULT '[]',
        "ledgerLocked" numeric(36, 18),
        "onChainBalance" numeric(36, 18),
        "error" text,
        "startedAt" TIMESTAMP NOT NULL,
        "finishedAt" TIMESTAMP,
        CONSTRAINT "PK_4edbdb165c9e754997036a4176a" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_reconciliation_run_started" ON "reconciliation_runs" ("startedAt")
    `);
    await queryRunner.query(`
      CREATE TABLE "escrow_refunds" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "escrowId" uuid NOT NULL,
        "reason" character varying(16) NOT NULL,
        "depositAmount" numeric(36, 18) NOT NULL,
        "spentAmount" numeric(36, 18) NOT NULL,
        "refundAmount" numeric(36, 18) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "txHash" character varying(66),
        "lastError" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "completedAt" TIMESTAMP,
        CONSTRAINT "PK_465b3d25fe8a34f484210756a18" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_escrow_refund_escrow" ON "escrow_refunds" ("escrowId")
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."settlements_status_enum" AS ENUM(
        'pending',
        'settled',
        'rejected',
        'retrying',
        'dead_letter'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "settlements" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "escrowId" character varying NOT NULL,
        "receiptsHash" character varying NOT NULL,
        "totalAmount" numeric(36, 18) NOT NULL,
        "feeAmount" numeric(36, 18),
        "status" "public"."settlements_status_enum" NOT NULL DEFAULT 'pending',
        "receiptCount" integer,
        "packedReceipts" text,
        "attempts" integer NOT NULL DEFAULT '0',
        "nextRetryAt" TIMESTAMP,
        "lastError" text,
        "txHash" character varying(66),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "settledAt" TIMESTAMP,
        CONSTRAINT "PK_5f523ce152b84e818bff9467aab" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_settlement_created_id" ON "settlements" ("createdAt", "id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_settlement_retry_queue" ON "settlements" ("status", "nextRetryAt")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_settlement_escrow_created" ON "settlements" ("escrowId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE TABLE "stream_claims" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "escrowId" character varying NOT NULL,
        "usageDelta" numeric(36, 18) NOT NULL,
        "cumulativeAmount" numeric(36, 18) NOT NULL,
        "claimedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_4ded3f101e03971d82f4a269c93" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_stream_claim_escrow_claimed" ON "stream_claims" ("escrowId", "claimedAt")
    `);
    await queryRunner.query(`
      CREATE TABLE "webhook_deliveries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subscriptionId" uuid NOT NULL,
        "event" character varying(64) NOT NULL,
        "payload" jsonb NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "attempts" integer NOT NULL DEFAULT '0',
        "responseStatus" integer,
        "lastError" text,
        "nextAttemptAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "deliveredAt" TIMESTAMP,
        CONSTRAINT "PK_535dd409947fb6d8fc6dfc0112a" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_webhook_delivery_retry_queue" ON "webhook_deliveries" ("status", "nextAttemptAt")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_webhook_delivery_subscription" ON "webhook_deliveries" ("subscriptionId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE TABLE "webhook_subscriptions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "url" character varying(2048) NOT NULL,
        "events" text NOT NULL,
        "secret" character varying(64) NOT NULL,
        "active" boolean NOT NULL DEFAULT true,
        "description" character varying(256),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_bf631ae77d39849d599817fb6f4" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE "webhook_subscriptions"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."IDX_webhook_delivery_subscription"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."IDX_webhook_delivery_retry_queue"
    `);
    await queryRunner.query(`
      DROP TABLE "webhook_deliveries"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."IDX_stream_claim_escrow_claimed"
    `);
    await queryRunner.query(`
      DROP TABLE "stream_claims"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."IDX_settlement_escrow_created"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."IDX_settlement_retry_queue"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."IDX_settlement_created_id"
    `);
    await queryRunner.query(`
      DROP TABLE "settlements"
    `);
    await queryRunner.query(`
      DROP TYPE "public"."settlements_status_enum"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."UQ_escrow_refund_escrow"
    `);
    await queryRunner.query(`
      DROP TABLE "escrow_refunds"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."IDX_reconciliation_run_started"
    `);
    await queryRunner.query(`
      DROP TABLE "reconciliation_runs"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."IDX_receipt_escrow_created"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."IDX_receipt_settlement_batch"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."IDX_receipt_unsettled"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."IDX_receipt_hash"
    `);
    await queryRunner.query(`
      DROP TABLE "payment_receipts"
    `);
    await queryRunner.query(`
      DROP TABLE "system_flags"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."IDX_fee_ledger_chain_type"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."UQ_fee_ledger_settlement"
    `);
    await queryRunner.query(`
      DROP TABLE "fee_ledger_entries"
    `);
    await queryRunner.query(`
      DROP TABLE "spending_limits"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."IDX_escrow_status_created"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."IDX_escrow_awaiting_refund"
    `);
    await queryRunner.query(`
      DROP TABLE "escrow_sessions"
    `);
    await queryRunner.query(`
      DROP TYPE "public"."escrow_sessions_status_enum"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."IDX_escrow_release_escrow"
    `);
    await queryRunner.query(`
      DROP TABLE "escrow_releases"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."UQ_idempotency_key_scope"
    `);
    await queryRunner.query(`
      DROP TABLE "idempotency_records"
    `);
  }

}
