import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FeeLedgerEntry } from './entities/fee-ledger-entry.entity';
import { FeeLedgerService } from './fee-ledger.service';
import { FeePolicyService } from './fee-policy.service';
import { FeesController } from './fees.controller';

@Module({
  imports: [TypeOrmModule.forFeature([FeeLedgerEntry])],
  controllers: [FeesController],
  providers: [FeePolicyService, FeeLedgerService],
  exports: [FeePolicyService, FeeLedgerService],
})
export class FeesModule {}
