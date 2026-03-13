import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseConfigFactory } from './config/database.config';
import blockchainConfig from './config/blockchain.config';
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
    EscrowModule,
    SettlementModule,
    StreamingModule,
    VerdictsModule,
    ReceiptsModule,
    HealthModule,
  ],
})
export class AppModule {}
