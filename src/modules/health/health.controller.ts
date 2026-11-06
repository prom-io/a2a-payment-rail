import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SkipAllThrottles } from '../../common/decorators/skip-throttle.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { PauseScope, PauseService } from '../ops/pause.service';

@ApiTags('health')
@SkipAllThrottles()
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly pauseService: PauseService) {}

  @Get()
  @ApiOperation({ summary: 'Health check' })
  @ApiResponse({ status: 200, description: 'Service is healthy' })
  check() {
    return {
      status: 'ok',
      service: 'a2a-payment-rail',
      version: process.env.npm_package_version ?? '0.1.0',
      timestamp: new Date().toISOString(),
      // A paused rail is healthy on purpose: restarting it would not help.
      paused: {
        settlement: this.pauseService.isPaused(PauseScope.SETTLEMENT),
        streaming: this.pauseService.isPaused(PauseScope.STREAMING),
      },
    };
  }
}
