import { Controller, Get, Post, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { VerdictsService } from './verdicts.service';

@ApiTags('verdicts')
@Controller('verdicts')
export class VerdictsController {
  constructor(private readonly verdictsService: VerdictsService) {}

  @Get(':sessionId/status')
  @ApiOperation({ summary: 'Get verdict status for a session' })
  getStatus(@Param('sessionId') sessionId: string) {
    return this.verdictsService.getStatus(sessionId);
  }

  @Post(':sessionId/release')
  @ApiOperation({ summary: 'Release funds based on verdict' })
  release(@Param('sessionId') sessionId: string) {
    return this.verdictsService.release(sessionId);
  }
}
