import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request } from 'express';

interface AuditEntry {
  timestamp: string;
  method: string;
  path: string;
  userId: string | null;
  ip: string;
  userAgent: string;
  statusCode: number;
  durationMs: number;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('AuditLog');
  private readonly MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();

    if (!this.MUTATING_METHODS.has(request.method)) {
      return next.handle();
    }

    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        const response = context.switchToHttp().getResponse();
        const entry: AuditEntry = {
          timestamp: new Date().toISOString(),
          method: request.method,
          path: request.url,
          userId: (request as Record<string, unknown>).user
            ? String(((request as Record<string, unknown>).user as Record<string, unknown>).userId ?? 'anonymous')
            : null,
          ip: request.ip ?? 'unknown',
          userAgent: request.get('user-agent') ?? 'unknown',
          statusCode: response.statusCode,
          durationMs: Date.now() - start,
        };
        this.logger.log(JSON.stringify(entry));
      }),
    );
  }
}
