import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';

export type SignerRole = 'current' | 'previous';

export interface Attestation {
  /** What is being vouched for, e.g. "receipt-batch-root". */
  purpose: string;
  /** The exact string that was signed (EIP-191 personal message). */
  message: string;
  signature: string;
  signer: string;
  signedAt: string;
}

export interface AttestationCheck {
  valid: boolean;
  signer: string | null;
  role: SignerRole | null;
  reason?: 'malformed' | 'unknown_signer' | 'previous_signer_expired';
}

export interface SignerStatus {
  current: { address: string };
  previous: { address: string; rotatedAt: string; acceptedUntil: string; accepted: boolean } | null;
  overlapSeconds: number;
}

const DEFAULT_OVERLAP_SECONDS = 86_400;
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ATTESTATION_PREFIX = 'prom-payment-rail:v1';

/**
 * The rail's signing keys, with rotation.
 *
 * A rotation is a configuration change:
 *
 *   BLOCKCHAIN_PRIVATE_KEY            the new key
 *   BLOCKCHAIN_PREVIOUS_PRIVATE_KEY   the key being retired
 *   SIGNER_ROTATED_AT                 when the new key took over (ISO-8601)
 *   SIGNER_OVERLAP_SECONDS            how long the old key stays accepted (default 24h)
 *
 * From the restart on, everything new is signed by the current key: every
 * transaction and every attestation. The previous key signs nothing any more.
 * It is only *accepted*, and only until `rotatedAt + overlap`: an attestation
 * it issued just before the rotation still verifies during the window, so
 * clients are not broken at the instant of the switch, and stops verifying
 * after it, so a leaked old key has a hard expiry.
 *
 * Without the two SIGNER_* variables there is one key and no window.
 */
@Injectable()
export class SignerKeyringService {
  private readonly logger = new Logger(SignerKeyringService.name);
  private readonly currentWallet: ethers.Wallet;
  private readonly previousAddress: string | null = null;
  private readonly rotatedAt: Date | null = null;
  private readonly overlapSeconds: number;

  constructor(configService: ConfigService) {
    const currentKey = configService.get<string>('blockchain.privateKey', DEV_KEY);
    this.currentWallet = wallet(currentKey, 'BLOCKCHAIN_PRIVATE_KEY');

    const overlap = Number(configService.get('blockchain.signerOverlapSeconds', DEFAULT_OVERLAP_SECONDS));
    if (!Number.isFinite(overlap) || overlap < 0) {
      throw new Error('SIGNER_OVERLAP_SECONDS must be a non-negative number');
    }
    this.overlapSeconds = overlap;

    const previousKey = String(configService.get('blockchain.previousPrivateKey', '') ?? '').trim();
    const rotatedAtRaw = String(configService.get('blockchain.signerRotatedAt', '') ?? '').trim();
    if (previousKey === '') {
      if (rotatedAtRaw !== '') {
        throw new Error('SIGNER_ROTATED_AT is set but BLOCKCHAIN_PREVIOUS_PRIVATE_KEY is not');
      }
      return;
    }

    const previous = wallet(previousKey, 'BLOCKCHAIN_PREVIOUS_PRIVATE_KEY');
    if (previous.address === this.currentWallet.address) {
      throw new Error('BLOCKCHAIN_PREVIOUS_PRIVATE_KEY is the same key as BLOCKCHAIN_PRIVATE_KEY');
    }
    const rotatedAt = new Date(rotatedAtRaw);
    // Without the instant of the rotation the window would have no end.
    if (rotatedAtRaw === '' || Number.isNaN(rotatedAt.getTime())) {
      throw new Error('SIGNER_ROTATED_AT must be an ISO-8601 instant when a previous signer key is configured');
    }
    this.previousAddress = previous.address;
    this.rotatedAt = rotatedAt;

    const until = this.overlapEndsAt()!;
    if (until.getTime() <= Date.now()) {
      this.logger.warn(
        `Signer overlap ended at ${until.toISOString()}: ${previous.address} is no longer accepted. ` +
          'Remove BLOCKCHAIN_PREVIOUS_PRIVATE_KEY and SIGNER_ROTATED_AT from the configuration.',
      );
    } else {
      this.logger.warn(
        `Signer rotation in progress: ${this.currentWallet.address} signs, ` +
          `${previous.address} is accepted until ${until.toISOString()}`,
      );
    }
  }

  /** Key that signs transactions. Only BlockchainService should need it. */
  get currentPrivateKey(): string {
    return this.currentWallet.privateKey;
  }

  get currentAddress(): string {
    return this.currentWallet.address;
  }

  overlapEndsAt(): Date | null {
    return this.rotatedAt ? new Date(this.rotatedAt.getTime() + this.overlapSeconds * 1000) : null;
  }

  /** Which of the rail's keys `address` is at instant `at`, or null if it is not (or no longer) one. */
  roleOf(address: string, at: Date = new Date()): SignerRole | null {
    const normalised = safeAddress(address);
    if (normalised === null) return null;
    if (normalised === this.currentWallet.address) return 'current';
    if (normalised === this.previousAddress && at.getTime() < this.overlapEndsAt()!.getTime()) {
      return 'previous';
    }
    return null;
  }

  /** Signs a statement of the rail with the current key. */
  async attest(purpose: string, payload: Record<string, string | number>, now: Date = new Date()): Promise<Attestation> {
    const signedAt = now.toISOString();
    const fields = Object.keys(payload)
      .sort()
      .map((key) => `${key}=${payload[key]}`)
      .join('&');
    const message = `${ATTESTATION_PREFIX}:${purpose}:${fields}:${signedAt}`;
    return {
      purpose,
      message,
      signature: await this.currentWallet.signMessage(message),
      signer: this.currentWallet.address,
      signedAt,
    };
  }

  /** True when `signature` over `message` comes from a key the rail accepts at instant `at`. */
  verify(message: string, signature: string, at: Date = new Date()): AttestationCheck {
    let signer: string;
    try {
      signer = ethers.verifyMessage(message, signature);
    } catch {
      return { valid: false, signer: null, role: null, reason: 'malformed' };
    }
    const role = this.roleOf(signer, at);
    if (role) return { valid: true, signer, role };
    return {
      valid: false,
      signer,
      role: null,
      reason: signer === this.previousAddress ? 'previous_signer_expired' : 'unknown_signer',
    };
  }

  status(at: Date = new Date()): SignerStatus {
    const until = this.overlapEndsAt();
    return {
      current: { address: this.currentWallet.address },
      previous:
        this.previousAddress && this.rotatedAt && until
          ? {
              address: this.previousAddress,
              rotatedAt: this.rotatedAt.toISOString(),
              acceptedUntil: until.toISOString(),
              accepted: at.getTime() < until.getTime(),
            }
          : null,
      overlapSeconds: this.overlapSeconds,
    };
  }
}

function wallet(privateKey: string, variable: string): ethers.Wallet {
  try {
    return new ethers.Wallet(privateKey);
  } catch {
    // ethers puts the offending value into its message; a key must never reach a log.
    throw new Error(`${variable} is not a valid private key`);
  }
}

function safeAddress(address: string): string | null {
  try {
    return ethers.getAddress(address);
  } catch {
    return null;
  }
}
