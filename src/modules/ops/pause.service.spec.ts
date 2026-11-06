import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { configStub } from '../../testing/stubs';
import { MetricsService } from '../metrics/metrics.service';
import { SystemFlag } from './entities/system-flag.entity';
import { PauseScope, PauseService } from './pause.service';

/** Two services over one table behave like two instances of the rail. */
function flagTable() {
  const rows = new Map<string, SystemFlag>();
  return {
    rows,
    repo: {
      create: (data: SystemFlag) => ({ ...data }),
      save: jest.fn(async (row: SystemFlag) => {
        rows.set(row.key, row);
        return row;
      }),
      find: jest.fn(async () => [...rows.values()]),
    },
  };
}

function instance(table = flagTable(), config: Record<string, unknown> = {}) {
  const metrics = new MetricsService();
  const service = new PauseService(
    table.repo as unknown as Repository<SystemFlag>,
    metrics,
    configStub(config),
  );
  return { service, table, metrics };
}

describe('PauseService', () => {
  it('lets everything through until somebody pauses', () => {
    const { service } = instance();

    expect(service.isPaused(PauseScope.SETTLEMENT)).toBe(false);
    expect(() => service.assertNotPaused(PauseScope.STREAMING)).not.toThrow();
    expect(service.status()).toEqual({
      settlement: { paused: false, source: null, reason: null, pausedBy: null, pausedAt: null },
      streaming: { paused: false, source: null, reason: null, pausedBy: null, pausedAt: null },
    });
  });

  it('pauses one scope at once and answers 503 with the reason', async () => {
    const { service } = instance();

    await service.pause([PauseScope.SETTLEMENT], 'hub exploit under investigation', 'ops-1');

    expect(service.isPaused(PauseScope.SETTLEMENT)).toBe(true);
    expect(service.isPaused(PauseScope.STREAMING)).toBe(false);
    expect(() => service.assertNotPaused(PauseScope.SETTLEMENT)).toThrow(ServiceUnavailableException);
    expect(() => service.assertNotPaused(PauseScope.SETTLEMENT)).toThrow(
      'settlement is paused by the operator: hub exploit under investigation',
    );
    expect(service.status().settlement).toMatchObject({ source: 'api', pausedBy: 'ops-1' });
  });

  it('resumes', async () => {
    const { service } = instance();
    await service.pause([PauseScope.SETTLEMENT, PauseScope.STREAMING], 'drill', 'ops-1');

    await service.resume([PauseScope.STREAMING], 'ops-2');

    expect(service.isPaused(PauseScope.STREAMING)).toBe(false);
    expect(service.isPaused(PauseScope.SETTLEMENT)).toBe(true);
  });

  it('reaches another instance on its next refresh and survives a restart', async () => {
    const table = flagTable();
    const first = instance(table).service;
    const second = instance(table).service;

    await first.pause([PauseScope.SETTLEMENT], 'incident 42', 'ops-1');
    expect(second.isPaused(PauseScope.SETTLEMENT)).toBe(false);
    await second.refresh();
    expect(second.isPaused(PauseScope.SETTLEMENT)).toBe(true);
    expect(second.status().settlement.reason).toBe('incident 42');

    const restarted = instance(table).service;
    await restarted.onModuleInit();
    restarted.onModuleDestroy();
    expect(restarted.isPaused(PauseScope.SETTLEMENT)).toBe(true);

    await first.resume([PauseScope.SETTLEMENT], 'ops-1');
    await second.refresh();
    expect(second.isPaused(PauseScope.SETTLEMENT)).toBe(false);
  });

  it('keeps the last known state when the database cannot be read', async () => {
    const { service, table } = instance();
    await service.pause([PauseScope.SETTLEMENT], 'incident', 'ops-1');
    table.repo.find.mockRejectedValueOnce(new Error('connection refused'));

    await service.refresh();

    expect(service.isPaused(PauseScope.SETTLEMENT)).toBe(true);
    expect(service.isPaused(PauseScope.STREAMING)).toBe(false);
  });

  it.each([
    ['all', [true, true]],
    ['settlement', [true, false]],
    [' Streaming , settlement ', [true, true]],
    ['', [false, false]],
  ])('EMERGENCY_PAUSE=%p pauses from the environment', (value, [settlement, streaming]) => {
    const { service } = instance(flagTable(), { EMERGENCY_PAUSE: value });

    expect(service.isPaused(PauseScope.SETTLEMENT)).toBe(settlement);
    expect(service.isPaused(PauseScope.STREAMING)).toBe(streaming);
  });

  it('cannot lift an environment pause through the API', async () => {
    const { service } = instance(flagTable(), { EMERGENCY_PAUSE: 'settlement' });

    await expect(service.resume([PauseScope.SETTLEMENT], 'ops-1')).rejects.toBeInstanceOf(ConflictException);
    expect(service.status().settlement).toMatchObject({ paused: true, source: 'env' });
    await expect(service.resume([PauseScope.STREAMING], 'ops-1')).resolves.toBeDefined();
  });

  it('refuses a misspelled EMERGENCY_PAUSE instead of ignoring it', () => {
    expect(() => instance(flagTable(), { EMERGENCY_PAUSE: 'settlments' })).toThrow(/EMERGENCY_PAUSE/);
  });

  it('exposes the switch as a gauge per scope', async () => {
    const { service, metrics } = instance();
    await service.pause([PauseScope.STREAMING], 'drill', 'ops-1');

    const scrape = await metrics.registry.metrics();

    expect(scrape).toContain('payment_rail_paused{scope="settlement"} 0');
    expect(scrape).toContain('payment_rail_paused{scope="streaming"} 1');
  });
});
