import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EscrowModule } from '../escrow/escrow.module';
import { Settlement } from '../settlement/entities/settlement.entity';
import { StreamClaim } from '../streaming/entities/stream-claim.entity';
import { EscrowRefund } from './entities/escrow-refund.entity';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';

// Reads settlements and stream claims through their repositories instead of
// importing those modules: both already depend on escrow, and refunds only
// needs two sums from them.
@Module({
  imports: [TypeOrmModule.forFeature([EscrowRefund, Settlement, StreamClaim]), EscrowModule],
  controllers: [RefundsController],
  providers: [RefundsService],
  exports: [RefundsService],
})
export class RefundsModule {}
