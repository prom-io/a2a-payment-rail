import { Controller, Get, Post, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { VerdictsService } from './verdicts.service';

@ApiTags('verdicts')
@Controller('verdicts')
export class VerdictsController {
  constructor(private readonly verdictsService: VerdictsService) {}

  @Get(':sessionId/status')
  @ApiOperation({ summary: 'Get verdict status for a session' })
  @ApiParam({ name: 'sessionId', description: 'Escrow session UUID' })
  @ApiResponse({ status: 200, description: 'Verdict status returned' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  getStatus(@Param('sessionId') sessionId: string) {
    return this.verdictsService.getStatus(sessionId);
  }

  @Post(':sessionId/release')
  @ApiOperation({ summary: 'Release funds based on verdict' })
  @ApiParam({ name: 'sessionId', description: 'Escrow session UUID' })
  @ApiResponse({ status: 200, description: 'Funds released successfully' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({ status: 409, description: 'Funds already released' })
  release(@Param('sessionId') sessionId: string) {
    return this.verdictsService.release(sessionId);
  }
}
