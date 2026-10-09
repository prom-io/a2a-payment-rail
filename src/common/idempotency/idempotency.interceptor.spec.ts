import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { Repository } from 'typeorm';
import { configStub } from '../../testing/stubs';
import { IdempotencyRecord, IdempotencyStatus } from './entities/idempotency-record.entity';
import { hashBody, IdempotencyInterceptor } from './idempotency.interceptor';

function recordStore() {
  const rows: IdempotencyRecord[] = [];
  let seq = 0;
  const repo = {
    create: jest.fn((data) => ({ ...data })),
    findOne: jest.fn(async ({ where }) =>
      rows.find((r) => r.key === where.key && r.scope === where.scope) ?? null,
    ),
    save: jest.fn(async (row: IdempotencyRecord) => {
      if (!row.id) {
        if (rows.some((r) => r.key === row.key && r.scope === row.scope)) {
          throw Object.assign(new Error('duplicate key'), { code: '23505' });
        }
        row.id = `record-${(seq += 1)}`;
        rows.push(row);
      }
      return row;
    }),
    delete: jest.fn(async (criteria: { id?: string }) => {
      if (!criteria.id) return;
      const index = rows.findIndex((r) => r.id === criteria.id);
      if (index >= 0) rows.splice(index, 1);
    }),
  };
  return { rows, repo };
}

function httpContext(key: string | undefined, body: unknown, path = '/escrow') {
  const setHeader = jest.fn();
  const request = { method: 'POST', path, body, headers: key === undefined ? {} : { 'idempotency-key': key } };
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader }) }),
  } as unknown as ExecutionContext;
  return { context, setHeader };
}

function handler(result: unknown): CallHandler & { handle: jest.Mock } {
  return { handle: jest.fn(() => of(result)) };
}

describe('IdempotencyInterceptor', () => {
  let store: ReturnType<typeof recordStore>;
  let interceptor: IdempotencyInterceptor;

  beforeEach(() => {
    store = recordStore();
    interceptor = new IdempotencyInterceptor(
      store.repo as unknown as Repository<IdempotencyRecord>,
      configStub({ IDEMPOTENCY_TTL_SECONDS: '60' }),
    );
  });

  const run = (key: string | undefined, body: unknown, next: CallHandler, path?: string) => {
    const { context, setHeader } = httpContext(key, body, path);
    return { result: lastValueFrom(interceptor.intercept(context, next)), setHeader };
  };

  it('passes requests without the header straight through', async () => {
    const next = handler({ id: 1 });

    await expect(run(undefined, { a: 1 }, next).result).resolves.toEqual({ id: 1 });

    expect(store.repo.save).not.toHaveBeenCalled();
  });

  it('runs the handler once and replays the stored response on a retry', async () => {
    const first = handler({ id: 'escrow-1', createdAt: new Date('2026-06-01T00:00:00Z') });
    const second = handler({ id: 'escrow-2' });

    await run('key-1', { amount: 5 }, first).result;
    const retry = run('key-1', { amount: 5 }, second);

    await expect(retry.result).resolves.toEqual({
      id: 'escrow-1',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    expect(second.handle).not.toHaveBeenCalled();
    expect(retry.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true');
    expect(store.rows[0].status).toBe(IdempotencyStatus.COMPLETED);
  });

  it('treats a reordered but equal body as the same request', async () => {
    await run('key-1', { a: 1, b: { c: 2, d: [1, 2] } }, handler('first')).result;

    await expect(run('key-1', { b: { d: [1, 2], c: 2 }, a: 1 }, handler('second')).result).resolves.toBe(
      'first',
    );
    expect(hashBody({ a: 1, b: 2 })).not.toBe(hashBody({ a: 2, b: 1 }));
  });

  it('rejects a reused key with a different body', async () => {
    await run('key-1', { amount: 5 }, handler('ok')).result;

    await expect(run('key-1', { amount: 6 }, handler('ok')).result).rejects.toMatchObject({ status: 422 });
  });

  it('scopes a key to its route', async () => {
    const other = handler('other');
    await run('key-1', {}, handler('first'), '/escrow/a/close').result;

    await expect(run('key-1', {}, other, '/escrow/b/close').result).resolves.toBe('other');
    expect(other.handle).toHaveBeenCalledTimes(1);
  });

  it('answers 409 while the first request is still in progress', async () => {
    store.rows.push({
      id: 'r',
      key: 'key-1',
      scope: 'POST /escrow',
      requestHash: hashBody({}),
      status: IdempotencyStatus.IN_PROGRESS,
      expiresAt: new Date(Date.now() + 60_000),
    } as IdempotencyRecord);

    await expect(run('key-1', {}, handler('x')).result).rejects.toMatchObject({ status: 409 });
  });

  it('answers 409 when it loses the insert race', async () => {
    store.repo.findOne.mockResolvedValueOnce(null);
    store.rows.push({ id: 'r', key: 'key-1', scope: 'POST /escrow' } as IdempotencyRecord);

    await expect(run('key-1', {}, handler('x')).result).rejects.toMatchObject({ status: 409 });
  });

  it('releases the key when the handler fails so the retry runs for real', async () => {
    const failing: CallHandler = { handle: () => throwError(() => new Error('chain down')) };

    await expect(run('key-1', {}, failing).result).rejects.toThrow('chain down');
    expect(store.rows).toHaveLength(0);

    await expect(run('key-1', {}, handler('recovered')).result).resolves.toBe('recovered');
  });

  it('forgets a key after its TTL', async () => {
    await run('key-1', {}, handler('old')).result;
    store.rows[0].expiresAt = new Date(Date.now() - 1);
    const next = handler('new');

    await expect(run('key-1', {}, next).result).resolves.toBe('new');
    expect(next.handle).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed keys', () => {
    expect(() => run('', {}, handler('x'))).toThrow(/Idempotency-Key/);
    expect(() => run('has space', {}, handler('x'))).toThrow(/Idempotency-Key/);
    expect(() => run('k'.repeat(256), {}, handler('x'))).toThrow(/Idempotency-Key/);
  });
});
