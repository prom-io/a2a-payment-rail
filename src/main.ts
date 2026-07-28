import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import compression from 'compression';
import * as bodyParser from 'body-parser';
import { AppModule } from './app.module';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { MetricsInterceptor } from './modules/metrics/metrics.interceptor';
import { MetricsService } from './modules/metrics/metrics.service';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { SanitizePipe } from './common/pipes/sanitize.pipe';
import { startTracing, stopTracing } from './observability/tracing';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  await startTracing(logger);
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const bodyLimit = process.env.BODY_LIMIT ?? '100kb';
  app.use(bodyParser.json({ limit: bodyLimit }));
  app.use(bodyParser.urlencoded({ limit: bodyLimit, extended: true }));
  app.use(compression());

  app.enableShutdownHooks();
  app.enableCors({
    origin: process.env.CORS_ORIGINS?.split(',') ?? ['http://localhost:3000'],
    credentials: true,
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new SanitizePipe(),
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const metricsService = app.get(MetricsService);
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new AuditInterceptor(),
    new MetricsInterceptor(metricsService),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  const config = new DocumentBuilder()
    .setTitle('A2A Payment Rail')
    .setDescription('PROM Micropayment & Settlement Rail API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .addTag('escrow', 'Escrow session management')
    .addTag('receipts', 'Payment receipt operations')
    .addTag('settlements', 'Batch settlement processing')
    .addTag('streaming', 'Micro-payment streaming claims')
    .addTag('verdicts', 'Verdict integration endpoints')
    .addTag('health', 'Service health checks')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? 3003;
  await app.listen(port);
  logger.log(`Payment Rail listening on port ${port}`);
  process.once('SIGINT', () => {
    void stopTracing(logger);
  });
  process.once('SIGTERM', () => {
    void stopTracing(logger);
  });
}

bootstrap();
