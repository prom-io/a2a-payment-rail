/**
 * Money as an integer number of wei.
 *
 * Amounts travel through the API and the database as decimal strings in the
 * native token ("1.5"), and a JS number cannot hold them: 0.1 + 0.2 is not 0.3
 * and anything above 2^53 wei (0.009 ether) is already rounded. Every sum,
 * comparison and conversion therefore goes through this class, which keeps the
 * value as a bigint scaled by 10^18.
 *
 * Instances are immutable; every operation returns a new Amount.
 */

const DECIMALS = 18;
const SCALE = 10n ** BigInt(DECIMALS);
const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;
const EXPONENT_PATTERN = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i;

export type AmountLike = Amount | string | number;

export class Amount {
  static readonly DECIMALS = DECIMALS;
  static readonly ZERO = new Amount(0n);

  private constructor(readonly wei: bigint) {}

  /** From an integer number of wei. */
  static fromWei(wei: bigint): Amount {
    return wei === 0n ? Amount.ZERO : new Amount(wei);
  }

  /**
   * From a decimal amount in the native token: "1.5", "1.500000000000000000"
   * (what Postgres returns for a numeric column) or a JS number as it arrives
   * in a DTO. Throws on anything that is not a plain decimal with at most 18
   * fractional digits; an amount is never silently rounded.
   */
  static from(value: AmountLike): Amount {
    if (value instanceof Amount) return value;
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError(`Invalid amount: ${value}`);
    }
    const text = expandExponent(String(value).trim());
    const match = DECIMAL_PATTERN.exec(text);
    if (!match) throw new TypeError(`Invalid amount: "${value}"`);

    const [, sign, whole, fractionRaw = ''] = match;
    // Trailing zeros carry no value: "1.50" with 20 zeros is still 1.5.
    const fraction = fractionRaw.replace(/0+$/, '');
    if (fraction.length > DECIMALS) {
      throw new TypeError(`Amount "${value}" has more than ${DECIMALS} decimals`);
    }
    const wei = BigInt(whole) * SCALE + BigInt(fraction.padEnd(DECIMALS, '0') || '0');
    return Amount.fromWei(sign === '-' ? -wei : wei);
  }

  /** True when `value` can be turned into an Amount. */
  static isValid(value: unknown): value is AmountLike {
    if (value instanceof Amount) return true;
    if (typeof value !== 'string' && typeof value !== 'number') return false;
    try {
      Amount.from(value);
      return true;
    } catch {
      return false;
    }
  }

  static sum(values: Iterable<AmountLike>): Amount {
    let total = 0n;
    for (const value of values) total += Amount.from(value).wei;
    return Amount.fromWei(total);
  }

  static min(a: AmountLike, b: AmountLike): Amount {
    const [left, right] = [Amount.from(a), Amount.from(b)];
    return left.wei <= right.wei ? left : right;
  }

  static max(a: AmountLike, b: AmountLike): Amount {
    const [left, right] = [Amount.from(a), Amount.from(b)];
    return left.wei >= right.wei ? left : right;
  }

  plus(other: AmountLike): Amount {
    return Amount.fromWei(this.wei + Amount.from(other).wei);
  }

  /** May go below zero; use minusFloored() for "what is left". */
  minus(other: AmountLike): Amount {
    return Amount.fromWei(this.wei - Amount.from(other).wei);
  }

  /** Subtraction that stops at zero: remaining balances and refunds are never negative. */
  minusFloored(other: AmountLike): Amount {
    const result = this.wei - Amount.from(other).wei;
    return result > 0n ? Amount.fromWei(result) : Amount.ZERO;
  }

  /** this * numerator / denominator, rounded down (towards zero for positive amounts). */
  mulDiv(numerator: bigint, denominator: bigint): Amount {
    if (denominator === 0n) throw new RangeError('Division by zero');
    return Amount.fromWei((this.wei * numerator) / denominator);
  }

  negated(): Amount {
    return Amount.fromWei(-this.wei);
  }

  eq(other: AmountLike): boolean {
    return this.wei === Amount.from(other).wei;
  }

  gt(other: AmountLike): boolean {
    return this.wei > Amount.from(other).wei;
  }

  gte(other: AmountLike): boolean {
    return this.wei >= Amount.from(other).wei;
  }

  lt(other: AmountLike): boolean {
    return this.wei < Amount.from(other).wei;
  }

  lte(other: AmountLike): boolean {
    return this.wei <= Amount.from(other).wei;
  }

  isZero(): boolean {
    return this.wei === 0n;
  }

  isNegative(): boolean {
    return this.wei < 0n;
  }

  /**
   * Shortest decimal form that keeps one fractional digit: "1.5", "2.0",
   * "0.000000000000000001". This is the form used in API responses.
   */
  toString(): string {
    const plain = this.toPlain();
    return plain.includes('.') ? plain : `${plain}.0`;
  }

  /** Shortest decimal form with no padding at all: "1.5", "2". */
  toPlain(): string {
    const negative = this.wei < 0n;
    const absolute = negative ? -this.wei : this.wei;
    const whole = absolute / SCALE;
    const fraction = (absolute % SCALE).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
  }

  /** All 18 fractional digits, the way a numeric(36,18) column prints it. */
  toFixed(): string {
    const negative = this.wei < 0n;
    const absolute = negative ? -this.wei : this.wei;
    const fraction = (absolute % SCALE).toString().padStart(DECIMALS, '0');
    return `${negative ? '-' : ''}${absolute / SCALE}.${fraction}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/** "1e-7" -> "0.0000001", "2.5e3" -> "2500": String(number) uses exponents outside 1e-7..1e21. */
function expandExponent(text: string): string {
  const match = EXPONENT_PATTERN.exec(text);
  if (!match) return text;
  const [, sign, whole, fraction = '', exponentRaw] = match;
  const exponent = Number(exponentRaw);
  if (Math.abs(exponent) > 60) throw new TypeError(`Invalid amount: "${text}"`);
  const digits = whole + fraction;
  const point = whole.length + exponent;
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}
