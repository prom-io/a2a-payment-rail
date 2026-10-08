import { ConfigService } from '@nestjs/config';

/**
 * Shared unit-test stubs. Kept out of *.spec.ts files on purpose: importing a
 * helper from another spec would register that spec's tests a second time.
 * This directory is excluded from the production build (tsconfig.build.json).
 */

/** ConfigService that answers from a plain map and honours the default argument. */
export function configStub(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback),
  } as unknown as ConfigService;
}
