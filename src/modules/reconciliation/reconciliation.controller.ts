import { Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { Role } from '../../common/auth/roles.enum';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ReconciliationService } from './reconciliation.service';

@ApiTags('reconciliation')
@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliationService: ReconciliationService) {}

  @Get('latest')
  @ApiOperation({ summary: 'Result of the most recent reconciliation run' })
  @ApiResponse({ status: 200, description: 'Latest run' })
  @ApiResponse({ status: 404, description: 'No run yet' })
  latest() {
    return this.reconciliationService.latest();
  }

  @Get('runs')
  @ApiOperation({ summary: 'Recent reconciliation runs, newest first' })
  @ApiQuery({ name: 'limit', required: false, description: '1-100, default 20' })
  @ApiResponse({ status: 200, description: 'Runs' })
  runs(@Query('limit') limit?: string) {
    const parsed = Number(limit);
    return this.reconciliationService.list(Number.isInteger(parsed) && parsed > 0 ? parsed : 20);
  }

  @Post('run')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Run a reconciliation now' })
  @ApiResponse({ status: 200, description: 'The finished run' })
  run() {
    return this.reconciliationService.run();
  }
}
