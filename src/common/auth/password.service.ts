import { Injectable } from '@nestjs/common';
import { scrypt, randomBytes, timingSafeEqual, ScryptOptions } from 'crypto';
import { promisify } from 'util';

// promisify() resolves to scrypt's three-argument overload, which drops the
// cost parameters silently. Pin the options-aware signature instead.
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCKSIZE = 8;
const SCRYPT_PARALLEL = 1;

@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    const derivedKey = (await scryptAsync(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCKSIZE,
      p: SCRYPT_PARALLEL,
    })) as Buffer;
    return `${salt}:${derivedKey.toString('hex')}`;
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const [salt, keyHex] = stored.split(':');
    if (!salt || !keyHex) return false;

    const storedKey = Buffer.from(keyHex, 'hex');
    const derivedKey = (await scryptAsync(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCKSIZE,
      p: SCRYPT_PARALLEL,
    })) as Buffer;

    if (storedKey.length !== derivedKey.length) return false;
    return timingSafeEqual(storedKey, derivedKey);
  }

  isPasswordStrong(password: string): { valid: boolean; reason?: string } {
    if (password.length < 12) return { valid: false, reason: 'Password must be at least 12 characters' };
    if (!/[A-Z]/.test(password)) return { valid: false, reason: 'Password must contain an uppercase letter' };
    if (!/[a-z]/.test(password)) return { valid: false, reason: 'Password must contain a lowercase letter' };
    if (!/[0-9]/.test(password)) return { valid: false, reason: 'Password must contain a digit' };
    if (!/[^A-Za-z0-9]/.test(password)) return { valid: false, reason: 'Password must contain a special character' };
    return { valid: true };
  }
}
