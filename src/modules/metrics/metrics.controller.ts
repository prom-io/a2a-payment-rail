import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { MetricsService } from './metrics.service';

@ApiTags('metrics')
@SkipThrottle()
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @ApiOperation({ summary: 'Prometheus metrics endpoint' })
  @ApiResponse({ status: 200, description: 'Metrics in Prometheus text format' })
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async metrics(): Promise<string> {
    return this.metricsService.registry.metrics();
  }
}
