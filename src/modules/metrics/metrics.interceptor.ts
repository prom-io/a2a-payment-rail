import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request, Response } from 'express';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.record(context, req, start),
        error: () => this.record(context, req, start),
      }),
    );
  }

  private record(context: ExecutionContext, req: Request, start: number): void {
    const res = context.switchToHttp().getResponse<Response>();
    const route = (req.route?.path as string | undefined) ?? req.path ?? 'unknown';
    const controller = context.getClass().name;
    const handler = context.getHandler().name;
    this.metricsService.observe(
      req.method,
      route,
      controller,
      handler,
      res.statusCode,
      Date.now() - start,
    );
  }
}
