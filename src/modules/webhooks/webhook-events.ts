/** Events a subscription can ask for. The string is what goes over the wire. */
export enum WebhookEvent {
  ESCROW_OPENED = 'escrow.opened',
  ESCROW_CLOSED = 'escrow.closed',
  SETTLEMENT_SETTLED = 'settlement.settled',
  SETTLEMENT_FAILED = 'settlement.failed',
}

export const WEBHOOK_EVENTS = Object.values(WebhookEvent);

/** Body of every delivery. `id` is stable across redeliveries of the same event. */
export interface WebhookEnvelope {
  id: string;
  event: WebhookEvent;
  createdAt: string;
  data: Record<string, unknown>;
}
