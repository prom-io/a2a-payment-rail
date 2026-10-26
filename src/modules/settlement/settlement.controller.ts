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
  Res,
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
import { Response } from 'express';
import { SettlementService } from './settlement.service';
import { SettlementExportService } from './settlement-export.service';
import { ExportSettlementsQueryDto } from './dto/export-settlements.dto';
import { SettleBatchDto } from './dto/settle-batch.dto';

@ApiTags('settlements')
@Controller('settlements')
export class SettlementController {
  constructor(
    private readonly settlementService: SettlementService,
    private readonly settlementExportService: SettlementExportService,
  ) {}

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

  // 'export' and 'dead-letter' are declared before ':id' so the literal
  // segments are not taken for an id.
  @Get('export')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SERVICE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Export settlements as CSV or NDJSON',
    description:
      'Oldest first. When more rows exist the response carries X-Next-Cursor; pass it back as ?cursor= for the next page.',
  })
  @ApiResponse({ status: 200, description: 'One page of the export as text' })
  @ApiResponse({ status: 400, description: 'Invalid format, limit, filter or cursor' })
  async export(
    @Query() query: ExportSettlementsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const page = await this.settlementExportService.exportPage(query);
    res.setHeader('Content-Type', page.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${page.filename}"`);
    res.setHeader('X-Export-Count', String(page.count));
    if (page.nextCursor) res.setHeader('X-Next-Cursor', page.nextCursor);
    return page.body;
  }

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
