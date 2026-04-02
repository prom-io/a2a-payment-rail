import { Controller, Post, Get, Param, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse, ApiParam } from '@nestjs/swagger';
import { SettlementService } from './settlement.service';
import { SettleBatchDto } from './dto/settle-batch.dto';

@ApiTags('settlements')
@Controller('settlements')
export class SettlementController {
  constructor(private readonly settlementService: SettlementService) {}

  @Post('batch')
  @ApiOperation({ summary: 'Submit a batch settlement' })
  @ApiResponse({ status: 201, description: 'Settlement batch submitted to chain' })
  @ApiResponse({ status: 400, description: 'Invalid settlement parameters' })
  settleBatch(@Body() dto: SettleBatchDto) {
    return this.settlementService.settleBatch(dto);
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
