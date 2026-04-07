import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { databaseConfigFactory } from './config/database.config';
import { throttlerConfigFactory } from './config/throttler.config';
import blockchainConfig from './config/blockchain.config';
import { BlockchainModule } from './common/blockchain/blockchain.module';
import { AuthModule } from './common/auth/auth.module';
import { EscrowModule } from './modules/escrow/escrow.module';
import { SettlementModule } from './modules/settlement/settlement.module';
import { StreamingModule } from './modules/streaming/streaming.module';
import { VerdictsModule } from './modules/verdicts/verdicts.module';
import { ReceiptsModule } from './modules/receipts/receipts.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [blockchainConfig],
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
    EscrowModule,
    SettlementModule,
    StreamingModule,
    VerdictsModule,
    ReceiptsModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
