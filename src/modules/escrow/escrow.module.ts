import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EscrowController } from './escrow.controller';
import { EscrowService } from './escrow.service';
import { EscrowSession } from './entities/escrow-session.entity';
import { EscrowRelease } from './entities/escrow-release.entity';
import { EscrowReleaseService } from './escrow-release.service';

@Module({
  imports: [TypeOrmModule.forFeature([EscrowSession, EscrowRelease])],
  controllers: [EscrowController],
  providers: [EscrowService, EscrowReleaseService],
  exports: [EscrowService, EscrowReleaseService],
})
export class EscrowModule {}
