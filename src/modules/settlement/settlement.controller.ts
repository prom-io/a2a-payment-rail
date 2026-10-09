import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
  ApiHeader,
} from '@nestjs/swagger';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Role } from '../../common/auth/roles.enum';
import { Roles } from '../../common/decorators/roles.decorator';
import { SettlementService } from './settlement.service';
import { SettleBatchDto } from './dto/settle-batch.dto';

@ApiTags('settlements')
@Controller('settlements')
export class SettlementController {
  constructor(private readonly settlementService: SettlementService) {}

  @Post('batch')
  @UseInterceptors(IdempotencyInterceptor)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Unique key; a retry with the same key and body replays the first response',
  })
  @ApiOperation({ summary: 'Submit a batch settlement' })
  @ApiResponse({ status: 201, description: 'Settlement batch submitted to chain' })
  @ApiResponse({ status: 400, description: 'Invalid settlement parameters' })
  settleBatch(@Body() dto: SettleBatchDto) {
    return this.settlementService.settleBatch(dto);
  }

  // Declared before ':id' so the literal segment is not taken for an id.
  @Get('dead-letter')
  @ApiOperation({ summary: 'List settlements that need an operator (dead_letter, rejected)' })
  @ApiResponse({ status: 200, description: 'Dead-lettered and rejected settlements' })
  findDeadLetters() {
    return this.settlementService.findDeadLetters();
  }

  @Post(':id/replay')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(IdempotencyInterceptor)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Manually replay a dead-lettered or rejected settlement' })
  @ApiParam({ name: 'id', description: 'Settlement UUID' })
  @ApiResponse({ status: 200, description: 'Settlement after the replay attempt' })
  @ApiResponse({ status: 404, description: 'Settlement not found' })
  @ApiResponse({ status: 409, description: 'Settlement is not in a replayable state' })
  replay(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.settlementService.replay(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get settlement by ID' })
  @ApiParam({ name: 'id', description: 'Settlement UUID' })
  @ApiResponse({ status: 200, description: 'Settlement details returned' })
  @ApiResponse({ status: 404, description: 'Settlement not found' })
  findOne(@Param('id') id: string) {
    return this.settlementService.findById(id);
  }

  @Get()
  @ApiOperation({ summary: 'List settlements by escrow ID' })
  @ApiQuery({ name: 'escrowId', required: true })
  @ApiResponse({ status: 200, description: 'Settlement list returned' })
  findByEscrow(@Query('escrowId') escrowId: string) {
    return this.settlementService.findByEscrowId(escrowId);
  }
}
