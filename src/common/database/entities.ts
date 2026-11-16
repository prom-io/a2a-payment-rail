import { IdempotencyRecord } from '../idempotency/entities/idempotency-record.entity';
import { EscrowRelease } from '../../modules/escrow/entities/escrow-release.entity';
import { EscrowSession } from '../../modules/escrow/entities/escrow-session.entity';
import { SpendingLimit } from '../../modules/escrow/entities/spending-limit.entity';
import { FeeLedgerEntry } from '../../modules/fees/entities/fee-ledger-entry.entity';
import { SystemFlag } from '../../modules/ops/entities/system-flag.entity';
import { PaymentReceipt } from '../../modules/receipts/entities/payment-receipt.entity';
import { ReconciliationRun } from '../../modules/reconciliation/entities/reconciliation-run.entity';
import { EscrowRefund } from '../../modules/refunds/entities/escrow-refund.entity';
import { Settlement } from '../../modules/settlement/entities/settlement.entity';
import { StreamClaim } from '../../modules/streaming/entities/stream-claim.entity';
import { WebhookDelivery } from '../../modules/webhooks/entities/webhook-delivery.entity';
import { WebhookSubscription } from '../../modules/webhooks/entities/webhook-subscription.entity';

/**
 * Every entity of the service, in one list.
 *
 * The application itself finds its entities through `autoLoadEntities`
 * (each module registers its own with `TypeOrmModule.forFeature`). The
 * migration CLI has no Nest container to ask, so it reads this list instead.
 * `registry.spec.ts` fails when an `*.entity.ts` file is missing here: an
 * entity the CLI does not know about would never get a migration, and the
 * first deploy with schema sync off would fail on a missing table.
 */
export const ENTITIES = [
  EscrowSession,
  EscrowRelease,
  SpendingLimit,
  PaymentReceipt,
  Settlement,
  StreamClaim,
  FeeLedgerEntry,
  EscrowRefund,
  ReconciliationRun,
  WebhookSubscription,
  WebhookDelivery,
  IdempotencyRecord,
  SystemFlag,
];
