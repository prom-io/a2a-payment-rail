import { Repository } from 'typeorm';
import { EscrowSession } from '../escrow/entities/escrow-session.entity';
import { StreamClaim } from '../streaming/entities/stream-claim.entity';
import { BusinessMetricsService } from './business-metrics.service';
import { MetricsService } from './metrics.service';

/**
 * Smoke coverage for the /metrics surface. Dashboards and alert rules are
 * written against these exact series names, so a rename that goes unnoticed
 * silently blinds on-call. This spec fails on that.
 */

type QueryBuilderStub = {
  select: jest.Mock;
  addSelect: jest.Mock;
  groupBy: jest.Mock;
  where: jest.Mock;
  innerJoin: jest.Mock;
  getRawMany: jest.Mock;
  getRawOne: jest.Mock;
  getCount: jest.Mock;
};

function queryBuilderStub(overrides: Partial<QueryBuilderStub> = {}): QueryBuilderStub {
  const qb: Partial<QueryBuilderStub> = {
    getRawMany: jest.fn().mockResolvedValue([]),
    getRawOne: jest.fn().mockResolvedValue({ total: '0' }),
    getCount: jest.fn().mockResolvedValue(0),
    ...overrides,
  };
  for (const chained of ['select', 'addSelect', 'groupBy', 'where', 'innerJoin'] as const) {
    qb[chained] = jest.fn().mockReturnValue(qb);
  }
  return qb as QueryBuilderStub;
}

function repositoryStub(qb: QueryBuilderStub) {
  return { createQueryBuilder: jest.fn().mockReturnValue(qb) };
}

const CORE_SERIES = [
  'http_requests_total',
  'http_request_duration_seconds',
  'payment_rail_escrow_sessions',
  'payment_rail_escrow_deposit_total',
  'payment_rail_stream_claims_active',
];

describe('metrics series', () => {
  let metrics: MetricsService;
  let escrowQb: QueryBuilderStub;
  let streamQb: QueryBuilderStub;

  beforeEach(() => {
    metrics = new MetricsService();
    metrics.onModuleInit();

    escrowQb = queryBuilderStub({
      getRawMany: jest.fn().mockResolvedValue([
        { status: 'open', count: '3' },
        { status: 'disputed', count: '1' },
      ]),
      getRawOne: jest.fn().mockResolvedValue({ total: '42.5' }),
    });
    streamQb = queryBuilderStub({ getCount: jest.fn().mockResolvedValue(7) });

    const business = new BusinessMetricsService(
      metrics,
      repositoryStub(escrowQb) as unknown as Repository<EscrowSession>,
      repositoryStub(streamQb) as unknown as Repository<StreamClaim>,
    );
    business.onModuleInit();
  });

  afterEach(() => {
    metrics.registry.clear();
  });

  it.each(CORE_SERIES)('exposes %s', async (series) => {
    const scrape = await metrics.registry.metrics();
    expect(scrape).toContain(series);
  });

  it('exposes default node metrics under the payment_rail_ prefix', async () => {
    const scrape = await metrics.registry.metrics();
    expect(scrape).toContain('payment_rail_process_cpu_user_seconds_total');
  });

  it('reports escrow counts per status with a chain label', async () => {
    const scrape = await metrics.registry.metrics();
    expect(scrape).toMatch(/payment_rail_escrow_sessions\{chain="[^"]+",status="open"\} 3/);
    expect(scrape).toMatch(/payment_rail_escrow_sessions\{chain="[^"]+",status="disputed"\} 1/);
  });

  it('reports zero for statuses the database did not return', async () => {
    const scrape = await metrics.registry.metrics();
    expect(scrape).toMatch(/payment_rail_escrow_sessions\{chain="[^"]+",status="closed"\} 0/);
  });

  it('reports held deposits and active stream claims', async () => {
    const scrape = await metrics.registry.metrics();
    expect(scrape).toMatch(/payment_rail_escrow_deposit_total\{chain="[^"]+"\} 42\.5/);
    expect(scrape).toMatch(/payment_rail_stream_claims_active\{chain="[^"]+"\} 7/);
  });

  it('still serves a scrape when the database is unreachable', async () => {
    escrowQb.getRawMany.mockRejectedValue(new Error('connection refused'));
    escrowQb.getRawOne.mockRejectedValue(new Error('connection refused'));
    streamQb.getCount.mockRejectedValue(new Error('connection refused'));

    const scrape = await metrics.registry.metrics();

    expect(scrape).toContain('payment_rail_escrow_deposit_total');
    expect(scrape).toMatch(/payment_rail_escrow_deposit_total\{chain="[^"]+"\} 0/);
  });
});
