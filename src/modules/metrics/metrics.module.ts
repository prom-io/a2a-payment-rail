import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EscrowSession } from '../escrow/entities/escrow-session.entity';
import { StreamClaim } from '../streaming/entities/stream-claim.entity';
import { BusinessMetricsService } from './business-metrics.service';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { MetricsInterceptor } from './metrics.interceptor';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([EscrowSession, StreamClaim])],
  controllers: [MetricsController],
  providers: [MetricsService, MetricsInterceptor, BusinessMetricsService],
  exports: [MetricsService, MetricsInterceptor],
})
export class MetricsModule {}
