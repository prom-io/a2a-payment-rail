import { Module } from '@nestjs/common';
import { FeePolicyService } from './fee-policy.service';
import { FeesController } from './fees.controller';

@Module({
  controllers: [FeesController],
  providers: [FeePolicyService],
  exports: [FeePolicyService],
})
export class FeesModule {}
