import { getMetadataArgsStorage } from 'typeorm';
import { EscrowSession } from '../../modules/escrow/entities/escrow-session.entity';
import { PaymentReceipt } from '../../modules/receipts/entities/payment-receipt.entity';
import { Settlement } from '../../modules/settlement/entities/settlement.entity';
import { StreamClaim } from '../../modules/streaming/entities/stream-claim.entity';
import { WebhookDelivery } from '../../modules/webhooks/entities/webhook-delivery.entity';

/**
 * The hot queries below are written against specific composite indexes. An
 * index removed or reordered by accident does not fail any functional test, it
 * just turns a range scan into a table scan in production. This spec fails
 * instead.
 */

type EntityClass = new () => object;
type IndexSpec = [name: string, columns: string[], where?: string];

function indexesOf(entity: EntityClass) {
  return getMetadataArgsStorage()
    .indices.filter((index) => index.target === entity)
    .map((index) => ({ name: index.name, columns: index.columns, where: index.where }));
}

const EXPECTED: Array<[entity: EntityClass, hotQuery: string, index: IndexSpec]> = [
  [PaymentReceipt, 'receipts of an escrow in creation order', ['IDX_receipt_escrow_created', ['escrowId', 'createdAt']]],
  [PaymentReceipt, 'receipts of a batch in leaf order', ['IDX_receipt_settlement_batch', ['settlementId', 'batchIndex']]],
  [PaymentReceipt, 'unsettled backlog scan', ['IDX_receipt_unsettled', ['createdAt', 'id'], '"settlementId" IS NULL']],
  [PaymentReceipt, 'lookup by receipt hash', ['IDX_receipt_hash', ['receiptHash']]],
  [EscrowSession, 'open sessions oldest first', ['IDX_escrow_status_created', ['status', 'createdAt']]],
  [EscrowSession, 'sessions awaiting a refund', ['IDX_escrow_awaiting_refund', ['status', 'closedAt'], '"refundedAt" IS NULL']],
  [Settlement, 'settlements of an escrow', ['IDX_settlement_escrow_created', ['escrowId', 'createdAt']]],
  [Settlement, 'retry queue poll', ['IDX_settlement_retry_queue', ['status', 'nextRetryAt']]],
  [Settlement, 'export keyset pagination', ['IDX_settlement_created_id', ['createdAt', 'id']]],
  [StreamClaim, 'latest claim of an escrow', ['IDX_stream_claim_escrow_claimed', ['escrowId', 'claimedAt']]],
  [WebhookDelivery, 'webhook retry queue poll', ['IDX_webhook_delivery_retry_queue', ['status', 'nextAttemptAt']]],
];

describe('composite indexes for hot queries', () => {
  it.each(EXPECTED)('%p: %s', (entity, _query, [name, columns, where]) => {
    const index = indexesOf(entity).find((candidate) => candidate.name === name);

    expect(index).toBeDefined();
    // column order matters: the equality column leads, the range/sort column follows
    expect(index!.columns).toEqual(columns);
    expect(index!.where).toBe(where);
  });

  it('names every index explicitly', () => {
    for (const [entity] of EXPECTED) {
      for (const index of indexesOf(entity)) expect(index.name).toMatch(/^(IDX|UQ)_/);
    }
  });

  it('indexes only columns that exist on the entity', () => {
    for (const [entity, , [, columns]] of EXPECTED) {
      const properties = getMetadataArgsStorage()
        .columns.filter((column) => column.target === entity)
        .map((column) => column.propertyName);
      for (const column of columns) expect(properties).toContain(column);
    }
  });
});
