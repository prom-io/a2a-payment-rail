import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { Role } from '../../common/auth/roles.enum';
import { RolesGuard } from '../../common/auth/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PauseDto, ResumeDto } from './dto/pause.dto';
import { PAUSE_SCOPES, PauseScope, PauseService } from './pause.service';

const scopesOf = (scope: string): PauseScope[] =>
  scope === 'all' ? [...PAUSE_SCOPES] : [scope as PauseScope];

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin')
export class PauseController {
  constructor(private readonly pauseService: PauseService) {}

  @Get('pause')
  @ApiOperation({ summary: 'State of the emergency pause per scope' })
  @ApiResponse({ status: 200, description: 'Pause state' })
  status() {
    return this.pauseService.status();
  }

  @Post('pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pause settlement payouts and/or stream claims' })
  @ApiResponse({ status: 200, description: 'Pause state after the change' })
  pause(@Body() dto: PauseDto, @CurrentUser('userId') actor: string) {
    return this.pauseService.pause(scopesOf(dto.scope), dto.reason, String(actor ?? 'unknown'));
  }

  @Post('resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lift the emergency pause' })
  @ApiResponse({ status: 200, description: 'Pause state after the change' })
  @ApiResponse({ status: 409, description: 'The scope is paused by EMERGENCY_PAUSE' })
  resume(@Body() dto: ResumeDto, @CurrentUser('userId') actor: string) {
    return this.pauseService.resume(scopesOf(dto.scope), String(actor ?? 'unknown'));
  }
}
