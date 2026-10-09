import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Request, Response } from 'express';
import { Observable, catchError, from, mergeMap, of, switchMap, throwError } from 'rxjs';
import { LessThan, Repository } from 'typeorm';
import { IdempotencyRecord, IdempotencyStatus } from './entities/idempotency-record.entity';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;
const PG_UNIQUE_VIOLATION = '23505';
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Makes a mutation safe to retry.
 *
 * A client sends `Idempotency-Key: <unique value>`; the first request runs the
 * handler and its response is stored. A retry with the same key and the same
 * body gets the stored response back and the handler is not run again, so a
 * timed-out "open escrow" cannot open two escrows.
 *
 *   same key, different body        -> 422
 *   same key, first still running   -> 409
 *   handler failed                  -> key released, the retry runs for real
 *
 * Requests without the header are passed through untouched.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly ttlMs: number;
  private lastPurgeAt = 0;

  constructor(
    @InjectRepository(IdempotencyRecord)
    private readonly records: Repository<IdempotencyRecord>,
    configService: ConfigService,
  ) {
    const ttlSeconds = Number(configService.get('IDEMPOTENCY_TTL_SECONDS', 86_400));
    this.ttlMs = (Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 86_400) * 1000;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const header = request.headers[IDEMPOTENCY_HEADER];
    if (header === undefined) return next.handle();

    const key = Array.isArray(header) ? header[0] : header;
    if (!KEY_PATTERN.test(key)) {
      throw new BadRequestException('Idempotency-Key must be 1-255 printable ASCII characters');
    }
    const scope = `${request.method} ${request.path}`;
    const requestHash = hashBody(request.body);

    return from(this.begin(key, scope, requestHash)).pipe(
      switchMap(({ record, replay }) => {
        if (replay) {
          http.getResponse<Response>().setHeader(IDEMPOTENCY_REPLAYED_HEADER, 'true');
          return of(record.responseBody);
        }
        return next.handle().pipe(
          mergeMap(async (body) => {
            await this.complete(record, body);
            return body;
          }),
          catchError((error) =>
            // Nothing was committed on behalf of this key: let the client retry.
            from(this.records.delete({ id: record.id })).pipe(
              switchMap(() => throwError(() => error)),
            ),
          ),
        );
      }),
    );
  }

  private async begin(
    key: string,
    scope: string,
    requestHash: string,
  ): Promise<{ record: IdempotencyRecord; replay: boolean }> {
    const now = new Date();
    await this.purgeExpired(now);

    let existing = await this.records.findOne({ where: { key, scope } });
    if (existing && existing.expiresAt.getTime() <= now.getTime()) {
      await this.records.delete({ id: existing.id });
      existing = null;
    }
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new UnprocessableEntityException(
          'Idempotency-Key was already used with a different request body',
        );
      }
      if (existing.status !== IdempotencyStatus.COMPLETED) {
        throw new ConflictException('A request with this Idempotency-Key is still in progress');
      }
      return { record: existing, replay: true };
    }

    try {
      const record = await this.records.save(
        this.records.create({
          key,
          scope,
          requestHash,
          status: IdempotencyStatus.IN_PROGRESS,
          responseBody: null,
          expiresAt: new Date(now.getTime() + this.ttlMs),
        }),
      );
      return { record, replay: false };
    } catch (error: any) {
      // Lost the race against a concurrent request with the same key.
      if ((error?.code ?? error?.driverError?.code) === PG_UNIQUE_VIOLATION) {
        throw new ConflictException('A request with this Idempotency-Key is still in progress');
      }
      throw error;
    }
  }

  private async complete(record: IdempotencyRecord, body: unknown): Promise<void> {
    record.status = IdempotencyStatus.COMPLETED;
    // Store what the client saw: the JSON form, not the entity instance.
    record.responseBody = body === undefined ? null : JSON.parse(JSON.stringify(body));
    await this.records.save(record);
  }

  /** Expired keys are dropped lazily, at most once an hour per instance. */
  private async purgeExpired(now: Date): Promise<void> {
    if (now.getTime() - this.lastPurgeAt < PURGE_INTERVAL_MS) return;
    this.lastPurgeAt = now.getTime();
    await this.records.delete({ expiresAt: LessThan(now) });
  }
}

/** sha256 over JSON with sorted keys, so property order does not change the hash. */
export function hashBody(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}
