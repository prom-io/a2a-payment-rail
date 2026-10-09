import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SecurityHeadersMiddleware } from './common/middleware/security-headers.middleware';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { databaseConfigFactory } from './config/database.config';
import { throttlerConfigFactory } from './config/throttler.config';
import blockchainConfig from './config/blockchain.config';
import securityConfig from './config/security.config';
import settlementConfig from './config/settlement.config';
import { BlockchainModule } from './common/blockchain/blockchain.module';
import { AuthModule } from './common/auth/auth.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { EscrowModule } from './modules/escrow/escrow.module';
import { SettlementModule } from './modules/settlement/settlement.module';
import { StreamingModule } from './modules/streaming/streaming.module';
import { VerdictsModule } from './modules/verdicts/verdicts.module';
import { ReceiptsModule } from './modules/receipts/receipts.module';
import { HealthModule } from './modules/health/health.module';
import { MetricsModule } from './modules/metrics/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [blockchainConfig, securityConfig, settlementConfig],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: databaseConfigFactory,
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: throttlerConfigFactory,
    }),
    BlockchainModule,
    AuthModule,
    IdempotencyModule,
    EscrowModule,
    SettlementModule,
    StreamingModule,
    VerdictsModule,
    ReceiptsModule,
    HealthModule,
    MetricsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SecurityHeadersMiddleware).forRoutes('*');
  }
}
