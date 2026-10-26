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
  createdAt: Date;
  id: string;
}

// Postgres keeps microseconds, a JS Date keeps milliseconds. Ordering and
// comparing on the truncated value keeps the cursor exact on both sides.
const CREATED_AT_MS = `date_trunc('milliseconds', settlement.createdAt)`;

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
      .orderBy(CREATED_AT_MS, 'ASC')
      .addOrderBy('settlement.id', 'ASC')
      // one extra row tells whether there is a next page without a COUNT
      .limit(limit + 1);

    if (cursor) {
      qb.andWhere(
        `(${CREATED_AT_MS} > :cursorAt OR (${CREATED_AT_MS} = :cursorAt AND settlement.id > :cursorId))`,
        { cursorAt: cursor.createdAt, cursorId: cursor.id },
      );
    }
    if (query.escrowId) qb.andWhere('settlement.escrowId = :escrowId', { escrowId: query.escrowId });
    if (query.status) qb.andWhere('settlement.status = :status', { status: query.status });
    if (query.from) qb.andWhere('settlement.createdAt >= :from', { from: new Date(query.from) });
    if (query.to) qb.andWhere('settlement.createdAt < :to', { to: new Date(query.to) });

    const rows = await qb.getMany();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last ? encodeCursor(last) : null;

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

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  const payload = JSON.stringify({ t: new Date(row.createdAt).toISOString(), id: row.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const createdAt = new Date(parsed.t);
    if (
      typeof parsed.id !== 'string' ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(parsed.id) ||
      Number.isNaN(createdAt.getTime())
    ) {
      throw new Error('bad cursor fields');
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException('cursor is not a value returned by a previous export page');
  }
}
