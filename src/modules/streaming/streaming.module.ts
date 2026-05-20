import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StreamingController } from './streaming.controller';
import { StreamingService } from './streaming.service';
import { StreamClaim } from './entities/stream-claim.entity';
import { EscrowModule } from '../escrow/escrow.module';

@Module({
  imports: [TypeOrmModule.forFeature([StreamClaim]), EscrowModule],
  controllers: [StreamingController],
  providers: [StreamingService],
  exports: [StreamingService],
})
export class StreamingModule {}
