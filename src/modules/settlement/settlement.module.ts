import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';
import { Settlement } from './entities/settlement.entity';
import { SettlementBatchScheduler } from './settlement-batch.scheduler';
import { ReceiptsModule } from '../receipts/receipts.module';

@Module({
  imports: [TypeOrmModule.forFeature([Settlement]), ReceiptsModule],
  controllers: [SettlementController],
  providers: [SettlementService, SettlementBatchScheduler],
  exports: [SettlementService, SettlementBatchScheduler],
})
export class SettlementModule {}
