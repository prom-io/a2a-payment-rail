import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExportFormat, ExportSettlementsQueryDto } from './dto/export-settlements.dto';
import { Settlement } from './entities/settlement.entity';

export const EXPORT_DEFAULT_LIMIT = 500;
export const EXPORT_MAX_LIMIT = 5_000;

/** Column order of the export; also the CSV header. */
export const EXPORT_COLUMNS = [
  'id',
  'escrowId',
  'status',
  'totalAmount',
  'feeAmount',
  'receiptsHash',
  'receiptCount',
  'attempts',
  'txHash',
  'createdAt',
  'settledAt',
] as const;

export interface ExportPage {
  body: string;
  contentType: string;
  filename: string;
  count: number;
  /** Pass back as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

interface Cursor {
  /** createdAt exactly as stored, microseconds included. */
  createdAt: string;
  id: string;
}

// Postgres keeps microseconds, a JS Date keeps milliseconds. The cursor
// therefore carries the timestamp as text straight from the database: the
// query can then order and compare on the bare column, which is what lets
// IDX_settlement_created_id serve it. (Truncating to milliseconds in SQL would
// be just as exact but turns the column into an expression no index covers.)
const CURSOR_TIMESTAMP = `to_char(settlement.createdAt, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
const CURSOR_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;

/**
 * Settlement export for accounting and audits.
 *
 * Pages are cut with a keyset cursor over (createdAt, id), not with OFFSET:
 * each page is an index range scan however deep the export goes, and rows
 * inserted while an export is running cannot shift rows between pages.
 */
@Injectable()
export class SettlementExportService {
  constructor(
    @InjectRepository(Settlement)
    private readonly settlements: Repository<Settlement>,
  ) {}

  async exportPage(query: ExportSettlementsQueryDto): Promise<ExportPage> {
    const format = query.format ?? ExportFormat.CSV;
    const limit = Math.min(query.limit ?? EXPORT_DEFAULT_LIMIT, EXPORT_MAX_LIMIT);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    const qb = this.settlements
      .createQueryBuilder('settlement')
      .addSelect(CURSOR_TIMESTAMP, 'cursor_timestamp')
      .orderBy('settlement.createdAt', 'ASC')
      .addOrderBy('settlement.id', 'ASC')
      // one extra row tells whether there is a next page without a COUNT
      .limit(limit + 1);

    if (cursor) {
      // Row comparison: one range condition on the (createdAt, id) index.
      qb.andWhere(
        '(settlement.createdAt, settlement.id) > (CAST(:cursorAt AS timestamp), CAST(:cursorId AS uuid))',
        { cursorAt: cursor.createdAt, cursorId: cursor.id },
      );
    }
    if (query.escrowId) qb.andWhere('settlement.escrowId = :escrowId', { escrowId: query.escrowId });
    if (query.status) qb.andWhere('settlement.status = :status', { status: query.status });
    if (query.from) qb.andWhere('settlement.createdAt >= :from', { from: new Date(query.from) });
    if (query.to) qb.andWhere('settlement.createdAt < :to', { to: new Date(query.to) });

    const { entities: rows, raw } = await qb.getRawAndEntities<{ cursor_timestamp: string }>();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last
        ? encodeCursor({ createdAt: raw[page.length - 1].cursor_timestamp, id: last.id })
        : null;

    return format === ExportFormat.NDJSON
      ? {
          body: page.map((row) => JSON.stringify(toRecord(row)) + '\n').join(''),
          contentType: 'application/x-ndjson; charset=utf-8',
          filename: 'settlements.ndjson',
          count: page.length,
          nextCursor,
        }
      : {
          // The header goes on the first page only, so pages concatenate into one valid file.
          body:
            (cursor ? '' : EXPORT_COLUMNS.join(',') + '\r\n') +
            page.map((row) => toCsvLine(toRecord(row))).join(''),
          contentType: 'text/csv; charset=utf-8',
          filename: 'settlements.csv',
          count: page.length,
          nextCursor,
        };
  }
}

type ExportRecord = Record<(typeof EXPORT_COLUMNS)[number], string | number | null>;

function toRecord(row: Settlement): ExportRecord {
  return {
    id: row.id,
    escrowId: row.escrowId,
    status: row.status,
    totalAmount: row.totalAmount,
    feeAmount: row.feeAmount ?? null,
    receiptsHash: row.receiptsHash,
    receiptCount: row.receiptCount ?? null,
    attempts: row.attempts ?? 0,
    txHash: row.txHash ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    settledAt: row.settledAt ? new Date(row.settledAt).toISOString() : null,
  };
}

function toCsvLine(record: ExportRecord): string {
  return EXPORT_COLUMNS.map((column) => csvCell(record[column])).join(',') + '\r\n';
}

/** RFC 4180 quoting, plus a guard against spreadsheet formula injection. */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function encodeCursor(row: Cursor): string {
  const payload = JSON.stringify({ t: row.createdAt, id: row.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed.id !== 'string' ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(parsed.id) ||
      typeof parsed.t !== 'string' ||
      !CURSOR_TIMESTAMP_PATTERN.test(parsed.t)
    ) {
      throw new Error('bad cursor fields');
    }
    return { createdAt: parsed.t, id: parsed.id };
  } catch {
    throw new BadRequestException('cursor is not a value returned by a previous export page');
  }
}
