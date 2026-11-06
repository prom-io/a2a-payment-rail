import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Gauge } from 'prom-client';
import { In, Repository } from 'typeorm';
import { MetricsService } from '../metrics/metrics.service';
import { SystemFlag } from './entities/system-flag.entity';

export enum PauseScope {
  /** Everything that pays a payee: settlements, their retries and replays, partial releases. */
  SETTLEMENT = 'settlement',
  /** Streaming claims. */
  STREAMING = 'streaming',
}

export const PAUSE_SCOPES = Object.values(PauseScope);

export interface PauseState {
  paused: boolean;
  /** `env` when EMERGENCY_PAUSE forces it; such a pause cannot be lifted through the API. */
  source: 'api' | 'env' | null;
  reason: string | null;
  pausedBy: string | null;
  pausedAt: string | null;
}

const NOT_PAUSED: PauseState = { paused: false, source: null, reason: null, pausedBy: null, pausedAt: null };
const flagKey = (scope: PauseScope) => `pause:${scope}`;

/**
 * Emergency pause switch.
 *
 * The switch is a row per scope in `system_flags`, so it survives restarts and
 * reaches every instance: each one re-reads it every PAUSE_REFRESH_MS (5 s).
 * Checks on the request path read the in-memory copy and cost nothing.
 *
 * EMERGENCY_PAUSE (`all`, or a comma-separated list of scopes) is the break-glass
 * variant for when the API or the admin token is the thing that is compromised:
 * it pauses from the environment and can only be lifted there.
 *
 * Pausing stops money from leaving towards payees. It never blocks what a
 * payer needs to get out: closing, cancelling and refunding stay available.
 */
@Injectable()
export class PauseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PauseService.name);
  private readonly forced: ReadonlySet<PauseScope>;
  private readonly refreshMs: number;
  private readonly state = new Map<PauseScope, PauseState>();
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(SystemFlag)
    private readonly flags: Repository<SystemFlag>,
    metrics: MetricsService,
    configService: ConfigService,
  ) {
    this.forced = parseForcedScopes(String(configService.get('EMERGENCY_PAUSE', '') ?? ''));
    const refreshMs = Number(configService.get('PAUSE_REFRESH_MS', 5_000));
    this.refreshMs = Number.isFinite(refreshMs) && refreshMs >= 250 ? refreshMs : 5_000;

    const gauge = new Gauge({
      name: 'payment_rail_paused',
      help: '1 while the emergency pause is active for the scope',
      labelNames: ['scope'] as const,
      registers: [metrics.registry],
      collect: () => {
        for (const scope of PAUSE_SCOPES) gauge.set({ scope }, this.isPaused(scope) ? 1 : 0);
      },
    });
  }

  async onModuleInit(): Promise<void> {
    if (this.forced.size > 0) {
      this.logger.warn(`EMERGENCY_PAUSE is set: ${[...this.forced].join(', ')} paused from the environment`);
    }
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  isPaused(scope: PauseScope): boolean {
    return this.forced.has(scope) || (this.state.get(scope)?.paused ?? false);
  }

  /** Throws 503 while the scope is paused. */
  assertNotPaused(scope: PauseScope): void {
    if (!this.isPaused(scope)) return;
    const reason = this.status()[scope].reason;
    throw new ServiceUnavailableException(
      `${scope} is paused by the operator${reason ? `: ${reason}` : ''}`,
    );
  }

  status(): Record<PauseScope, PauseState> {
    const result = {} as Record<PauseScope, PauseState>;
    for (const scope of PAUSE_SCOPES) {
      result[scope] = this.forced.has(scope)
        ? { paused: true, source: 'env', reason: 'EMERGENCY_PAUSE', pausedBy: null, pausedAt: null }
        : (this.state.get(scope) ?? NOT_PAUSED);
    }
    return result;
  }

  async pause(scopes: PauseScope[], reason: string, actor: string): Promise<Record<PauseScope, PauseState>> {
    const pausedAt = new Date().toISOString();
    for (const scope of scopes) {
      const value: PauseState = { paused: true, source: 'api', reason, pausedBy: actor, pausedAt };
      await this.flags.save(this.flags.create({ key: flagKey(scope), value, updatedBy: actor }));
      // Effective here at once; the other instances follow on their next refresh.
      this.state.set(scope, value);
    }
    this.logger.error(`EMERGENCY PAUSE of ${scopes.join(', ')} by ${actor}: ${reason}`);
    return this.status();
  }

  async resume(scopes: PauseScope[], actor: string): Promise<Record<PauseScope, PauseState>> {
    const forced = scopes.filter((scope) => this.forced.has(scope));
    if (forced.length > 0) {
      throw new ConflictException(
        `${forced.join(', ')} is paused by EMERGENCY_PAUSE; remove it from the environment and restart`,
      );
    }
    for (const scope of scopes) {
      await this.flags.save(this.flags.create({ key: flagKey(scope), value: NOT_PAUSED, updatedBy: actor }));
      this.state.set(scope, NOT_PAUSED);
    }
    this.logger.warn(`Pause of ${scopes.join(', ')} lifted by ${actor}`);
    return this.status();
  }

  /**
   * Re-reads the switch. On a database error the last known state is kept: a
   * blip must neither lift a pause nor impose one.
   */
  async refresh(): Promise<void> {
    try {
      const rows = await this.flags.find({ where: { key: In(PAUSE_SCOPES.map(flagKey)) } });
      for (const scope of PAUSE_SCOPES) {
        const row = rows.find((candidate) => candidate.key === flagKey(scope));
        this.state.set(scope, row?.value?.paused ? { ...NOT_PAUSED, ...row.value } : NOT_PAUSED);
      }
    } catch (error) {
      this.logger.warn(`Pause state refresh failed, keeping the last known state: ${(error as Error).message}`);
    }
  }
}

function parseForcedScopes(raw: string): ReadonlySet<PauseScope> {
  const forced = new Set<PauseScope>();
  for (const item of raw.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean)) {
    if (item === 'all' || item === 'true') PAUSE_SCOPES.forEach((scope) => forced.add(scope));
    else if ((PAUSE_SCOPES as string[]).includes(item)) forced.add(item as PauseScope);
    // A typo in a break-glass variable must not be read as "not paused".
    else throw new Error(`EMERGENCY_PAUSE: "${item}" is not one of: all, ${PAUSE_SCOPES.join(', ')}`);
  }
  return forced;
}
