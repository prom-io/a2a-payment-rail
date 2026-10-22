import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EscrowController } from './escrow.controller';
import { EscrowService } from './escrow.service';
import { EscrowSession } from './entities/escrow-session.entity';
import { EscrowRelease } from './entities/escrow-release.entity';
import { EscrowReleaseService } from './escrow-release.service';
import { SpendingLimit } from './entities/spending-limit.entity';
import { SpendingLimitService } from './spending-limit.service';
import { SpendingLimitsController } from './spending-limits.controller';

@Module({
  imports: [TypeOrmModule.forFeature([EscrowSession, EscrowRelease, SpendingLimit])],
  controllers: [EscrowController, SpendingLimitsController],
  providers: [EscrowService, EscrowReleaseService, SpendingLimitService],
  exports: [EscrowService, EscrowReleaseService, SpendingLimitService],
})
export class EscrowModule {}
