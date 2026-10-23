import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EscrowSession } from '../escrow/entities/escrow-session.entity';
import { Settlement } from '../settlement/entities/settlement.entity';
import { ReconciliationRun } from './entities/reconciliation-run.entity';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';

// Read-only over escrow and settlement tables, so it takes their repositories
// directly and depends on neither module.
@Module({
  imports: [TypeOrmModule.forFeature([ReconciliationRun, EscrowSession, Settlement])],
  controllers: [ReconciliationController],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
