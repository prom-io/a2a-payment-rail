import { Controller, Post, Get, Param, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { SettlementService } from './settlement.service';
import { SettleBatchDto } from './dto/settle-batch.dto';

@ApiTags('settlements')
@Controller('settlements')
export class SettlementController {
  constructor(private readonly settlementService: SettlementService) {}

  @Post('batch')
  @ApiOperation({ summary: 'Submit a batch settlement' })
  settleBatch(@Body() dto: SettleBatchDto) {
    return this.settlementService.settleBatch(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get settlement by ID' })
  findOne(@Param('id') id: string) {
    return this.settlementService.findById(id);
  }

  @Get()
  @ApiOperation({ summary: 'List settlements by escrow ID' })
  @ApiQuery({ name: 'escrowId', required: true })
  findByEscrow(@Query('escrowId') escrowId: string) {
    return this.settlementService.findByEscrowId(escrowId);
  }
}
