import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RawFeePolicy } from '../../config/fees.config';
import { assertValidPolicy, computeFee, FeeBound, FeePolicy } from './fee-policy';
import { Amount } from '../../common/money/amount';

const AMOUNT_PATTERN = /^\d{1,18}(\.\d{1,18})?$/;

export interface FeeQuote {
  chainId: number;
  amount: string;
  fee: string;
  net: string;
  bps: number;
  bound: FeeBound;
}

export interface FeePolicyView {
  chainId: number | 'default';
  bps: number;
  minFee: string;
  maxFee: string | null;
}

/**
 * Resolves the fee policy of a chain and quotes fees with it.
 *
 * Policies are read once at startup and validated there, so a bad rate stops
 * the service from booting instead of surfacing on the first settlement.
 */
@Injectable()
export class FeePolicyService {
  private readonly logger = new Logger(FeePolicyService.name);
  private readonly defaultPolicy: FeePolicy;
  private readonly chainPolicies = new Map<number, FeePolicy>();
  readonly chainId: number;

  constructor(configService: ConfigService) {
    this.chainId = configService.get<number>('fees.chainId', 31337);
    this.defaultPolicy = this.parsePolicy(
      {
        bps: configService.get<number>('fees.defaultBps', 50),
        minFee: configService.get<string>('fees.defaultMinFee', '0'),
        maxFee: configService.get<string>('fees.defaultMaxFee', ''),
      },
      null,
      'default fee policy',
    );

    const overrides = configService.get<Record<string, RawFeePolicy>>('fees.policies', {});
    for (const [chain, raw] of Object.entries(overrides)) {
      const chainId = Number(chain);
      if (!Number.isInteger(chainId) || chainId <= 0) {
        throw new Error(`FEE_POLICIES: "${chain}" is not a chain id`);
      }
      this.chainPolicies.set(
        chainId,
        this.parsePolicy(raw, this.defaultPolicy, `fee policy for chain ${chainId}`),
      );
    }
    this.logger.log(
      `Fee policies loaded: default ${this.defaultPolicy.bps} bps, ` +
        `${this.chainPolicies.size} per-chain override(s)`,
    );
  }

  policyFor(chainId: number): FeePolicy {
    return this.chainPolicies.get(chainId) ?? this.defaultPolicy;
  }

  /** Fee for an amount given as a decimal string in the native token. */
  quote(amount: string, chainId: number = this.chainId): FeeQuote {
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new BadRequestException('amount must be a non-negative decimal with up to 18 decimals');
    }
    const breakdown = computeFee(Amount.from(amount).wei, this.policyFor(chainId));
    return {
      chainId,
      amount: Amount.fromWei(breakdown.amount).toString(),
      fee: Amount.fromWei(breakdown.fee).toString(),
      net: Amount.fromWei(breakdown.net).toString(),
      bps: breakdown.bps,
      bound: breakdown.bound,
    };
  }

  listPolicies(): FeePolicyView[] {
    const view = (chainId: number | 'default', policy: FeePolicy): FeePolicyView => ({
      chainId,
      bps: policy.bps,
      minFee: Amount.fromWei(policy.minFee).toString(),
      maxFee: policy.maxFee === null ? null : Amount.fromWei(policy.maxFee).toString(),
    });
    return [
      view('default', this.defaultPolicy),
      ...[...this.chainPolicies.entries()]
        .sort(([a], [b]) => a - b)
        .map(([chainId, policy]) => view(chainId, policy)),
    ];
  }

  private parsePolicy(raw: RawFeePolicy, fallback: FeePolicy | null, label: string): FeePolicy {
    const amount = (value: string | undefined, field: string): bigint | undefined => {
      if (value === undefined || value === '') return undefined;
      if (!AMOUNT_PATTERN.test(String(value))) {
        throw new Error(`${label}: ${field} must be a decimal string, got "${value}"`);
      }
      return Amount.from(value).wei;
    };
    const policy: FeePolicy = {
      bps: raw.bps ?? fallback?.bps ?? 0,
      minFee: amount(raw.minFee, 'minFee') ?? fallback?.minFee ?? 0n,
      maxFee: amount(raw.maxFee, 'maxFee') ?? fallback?.maxFee ?? null,
    };
    assertValidPolicy(policy, label);
    return policy;
  }
}
