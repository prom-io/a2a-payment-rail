import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Webhook signatures.
 *
 *   X-Prom-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
 *   signed payload  : "<t>.<raw request body>"
 *
 * The timestamp is inside the signed payload, so it cannot be changed without
 * invalidating the signature. A receiver rejects signatures older than its
 * tolerance, which bounds how long a captured request can be replayed; inside
 * that window it deduplicates on the delivery id (X-Prom-Delivery).
 */

export const SIGNATURE_HEADER = 'X-Prom-Signature';
export const SIGNATURE_VERSION = 'v1';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureFailure =
  | 'malformed_header'
  | 'timestamp_out_of_tolerance'
  | 'signature_mismatch';

export interface SignatureCheck {
  valid: boolean;
  reason?: SignatureFailure;
  timestamp?: number;
}

export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

export function buildSignatureHeader(secret: string, body: string, now: Date = new Date()): string {
  const timestamp = Math.floor(now.getTime() / 1000);
  return `t=${timestamp},${SIGNATURE_VERSION}=${computeSignature(secret, timestamp, body)}`;
}

/**
 * Receiver-side check. `body` must be the raw bytes as received: re-serialised
 * JSON is not guaranteed to be byte-identical and will not verify.
 */
export function verifySignatureHeader(params: {
  secret: string;
  header: string | undefined;
  body: string;
  toleranceSeconds?: number;
  now?: Date;
}): SignatureCheck {
  const parsed = parseHeader(params.header);
  if (!parsed) return { valid: false, reason: 'malformed_header' };

  const tolerance = params.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((params.now ?? new Date()).getTime() / 1000);
  // Symmetric: a timestamp from the future is as suspicious as a stale one.
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
    return { valid: false, reason: 'timestamp_out_of_tolerance', timestamp: parsed.timestamp };
  }

  const expected = Buffer.from(computeSignature(params.secret, parsed.timestamp, params.body), 'hex');
  // Several v1 values are allowed so a receiver can accept two secrets while rotating.
  const matches = parsed.signatures.some((candidate) => {
    const given = Buffer.from(candidate, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return matches
    ? { valid: true, timestamp: parsed.timestamp }
    : { valid: false, reason: 'signature_mismatch', timestamp: parsed.timestamp };
}

function parseHeader(header: string | undefined): { timestamp: number; signatures: string[] } | null {
  if (!header) return null;
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 0) return null;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') {
      if (!/^\d{1,12}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === SIGNATURE_VERSION) {
      if (!/^[0-9a-f]{64}$/.test(value)) return null;
      signatures.push(value);
    }
    // unknown keys are ignored so a future v2 can be added next to v1
  }
  if (timestamp === undefined || signatures.length === 0) return null;
  return { timestamp, signatures };
}
