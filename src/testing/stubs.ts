import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Shared unit-test stubs. Kept out of *.spec.ts files on purpose: importing a
 * helper from another spec would register that spec's tests a second time.
 * This directory is excluded from the production build (tsconfig.build.json).
 */

/** PauseService with the switch off; flip `paused` to turn a scope (or all of them) on. */
export interface PauseStub {
  paused: boolean;
  isPaused: jest.Mock<boolean, []>;
  assertNotPaused: jest.Mock<void, []>;
}

export function pauseStub(): PauseStub {
  const stub: PauseStub = {
    paused: false,
    isPaused: jest.fn(() => stub.paused),
    assertNotPaused: jest.fn(() => {
      if (stub.paused) throw new ServiceUnavailableException('paused by the operator');
    }),
  };
  return stub;
}

/** ConfigService that answers from a plain map and honours the default argument. */
export function configStub(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback),
  } as unknown as ConfigService;
}
