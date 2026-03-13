import { Module } from '@nestjs/common';
import { VerdictsController } from './verdicts.controller';
import { VerdictsService } from './verdicts.service';

@Module({
  controllers: [VerdictsController],
  providers: [VerdictsService],
  exports: [VerdictsService],
})
export class VerdictsModule {}
