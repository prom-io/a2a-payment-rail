import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ExportFormat } from './dto/export-settlements.dto';
import { Settlement, SettlementStatus } from './entities/settlement.entity';
import {
  csvCell,
  decodeCursor,
  encodeCursor,
  EXPORT_COLUMNS,
  SettlementExportService,
} from './settlement-export.service';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

function settlement(n: number, overrides: Partial<Settlement> = {}): Settlement {
  return {
    id: uuid(n),
    escrowId: uuid(1000),
    receiptsHash: '0x' + 'ab'.repeat(32),
    totalAmount: `${n}.500000000000000000`,
    feeAmount: '0.007500000000000000',
    status: SettlementStatus.SETTLED,
    receiptCount: 3,
    attempts: 1,
    txHash: '0x' + 'cd'.repeat(32),
    // several rows share a millisecond, as they do under load
    createdAt: new Date(Date.UTC(2026, 5, 1, 12, 0, 0, Math.floor(n / 2))),
    settledAt: new Date(Date.UTC(2026, 5, 1, 12, 0, 1)),
    ...overrides,
  } as Settlement;
}

/** Applies the keyset predicate and the filters the way the SQL does. */
function build(rows: Settlement[]) {
  const calls: Array<{ sql: string; params: Record<string, any> }> = [];
  const repo = {
    createQueryBuilder: () => {
      let limit = Infinity;
      const params: Record<string, any> = {};
      const qb: any = {
        orderBy: () => qb,
        addOrderBy: () => qb,
        limit: (n: number) => {
          limit = n;
          return qb;
        },
        andWhere: (sql: string, p: Record<string, unknown>) => {
          calls.push({ sql, params: p });
          Object.assign(params, p);
          return qb;
        },
        getMany: async () =>
          rows
            .filter((r) => {
              const t = r.createdAt.getTime();
              if (params.cursorAt) {
                const c = params.cursorAt.getTime();
                if (!(t > c || (t === c && r.id > params.cursorId))) return false;
              }
              if (params.escrowId && r.escrowId !== params.escrowId) return false;
              if (params.status && r.status !== params.status) return false;
              if (params.from && t < params.from.getTime()) return false;
              if (params.to && t >= params.to.getTime()) return false;
              return true;
            })
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
            .slice(0, limit),
      };
      return qb;
    },
  };
  return { service: new SettlementExportService(repo as unknown as Repository<Settlement>), calls };
}

describe('SettlementExportService', () => {
  it('writes csv with a header, one line per settlement and CRLF line ends', async () => {
    const { service } = build([settlement(1), settlement(2, { settledAt: null, txHash: null, feeAmount: null })]);

    const page = await service.exportPage({});
    const lines = page.body.split('\r\n');

    expect(page).toMatchObject({ contentType: 'text/csv; charset=utf-8', count: 2, nextCursor: null });
    expect(lines[0]).toBe(EXPORT_COLUMNS.join(','));
    expect(lines[1]).toBe(
      [
        uuid(1),
        uuid(1000),
        'settled',
        '1.500000000000000000',
        '0.007500000000000000',
        '0x' + 'ab'.repeat(32),
        3,
        1,
        '0x' + 'cd'.repeat(32),
        '2026-06-01T12:00:00.000Z',
        '2026-06-01T12:00:01.000Z',
      ].join(','),
    );
    expect(lines[2].split(',')).toHaveLength(EXPORT_COLUMNS.length);
    expect(lines[2].endsWith(',2026-06-01T12:00:00.001Z,')).toBe(true);
    expect(lines[3]).toBe('');
  });

  it('writes ndjson with the same fields, one object per line', async () => {
    const { service } = build([settlement(1), settlement(2)]);

    const page = await service.exportPage({ format: ExportFormat.NDJSON });
    const objects = page.body.trimEnd().split('\n').map((line) => JSON.parse(line));

    expect(page.contentType).toBe('application/x-ndjson; charset=utf-8');
    expect(page.body.endsWith('\n')).toBe(true);
    expect(Object.keys(objects[0])).toEqual([...EXPORT_COLUMNS]);
    expect(objects.map((o) => o.id)).toEqual([uuid(1), uuid(2)]);
    // amounts stay strings: a JSON number would lose precision
    expect(objects[0].totalAmount).toBe('1.500000000000000000');
  });

  it('pages through every row exactly once, in order, even when timestamps collide', async () => {
    const rows = Array.from({ length: 23 }, (_, i) => settlement(i + 1));
    const { service } = build([...rows].reverse());

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await service.exportPage({ format: ExportFormat.NDJSON, limit: 5, cursor });
      seen.push(...page.body.trimEnd().split('\n').map((line) => JSON.parse(line).id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(5);
    expect(seen).toEqual(rows.map((r) => r.id));
  });

  it('puts the csv header on the first page only', async () => {
    const { service } = build([settlement(1), settlement(2), settlement(3)]);

    const first = await service.exportPage({ limit: 2 });
    const second = await service.exportPage({ limit: 2, cursor: first.nextCursor! });

    expect(first.body.startsWith('id,escrowId')).toBe(true);
    expect(second.body.startsWith(uuid(3))).toBe(true);
    expect((first.body + second.body).split('\r\n').filter(Boolean)).toHaveLength(4);
    expect(second.nextCursor).toBeNull();
  });

  it('reports no next page when the last page is exactly full', async () => {
    const { service } = build([settlement(1), settlement(2)]);
    expect((await service.exportPage({ limit: 2 })).nextCursor).toBeNull();
  });

  it('filters by escrow, status and creation time', async () => {
    const other = uuid(2000);
    const { service } = build([
      settlement(1),
      settlement(2, { escrowId: other }),
      settlement(3, { status: SettlementStatus.DEAD_LETTER }),
      settlement(40),
    ]);
    const ids = async (query: Parameters<typeof service.exportPage>[0]) =>
      (await service.exportPage({ format: ExportFormat.NDJSON, ...query })).body
        .trimEnd()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).id);

    expect(await ids({ escrowId: other })).toEqual([uuid(2)]);
    expect(await ids({ status: SettlementStatus.DEAD_LETTER })).toEqual([uuid(3)]);
    expect(await ids({ from: '2026-06-01T12:00:00.010Z' })).toEqual([uuid(40)]);
    expect(await ids({ to: '2026-06-01T12:00:00.001Z' })).toEqual([uuid(1)]);
  });

  it('clamps the page size to the maximum', async () => {
    const { service } = build(Array.from({ length: 3 }, (_, i) => settlement(i + 1)));
    expect((await service.exportPage({ limit: 1_000_000 })).count).toBe(3);
  });

  it('rejects a cursor it did not issue', async () => {
    const { service } = build([]);
    const forged = Buffer.from(JSON.stringify({ t: 'yesterday', id: 'x' })).toString('base64url');

    await expect(service.exportPage({ cursor: 'not-base64-json' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.exportPage({ cursor: forged })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('round-trips a cursor', () => {
    const row = settlement(7);
    expect(decodeCursor(encodeCursor(row))).toEqual({ createdAt: row.createdAt, id: row.id });
  });
});

describe('csvCell', () => {
  it('quotes separators, quotes and line breaks', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
  });

  it('defuses values a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+1')).toBe(`'+1`);
    expect(csvCell('@cmd')).toBe(`'@cmd`);
    // numbers are numbers, a leading minus is not an attack
    expect(csvCell(-5)).toBe('-5');
  });
});
