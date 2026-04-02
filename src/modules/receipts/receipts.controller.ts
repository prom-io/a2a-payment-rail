import { Controller, Post, Get, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { ReceiptsService } from './receipts.service';
import { CreateReceiptDto } from './dto/create-receipt.dto';
import { ValidateReceiptDto } from './dto/validate-receipt.dto';

@ApiTags('receipts')
@Controller('receipts')
export class ReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a payment receipt' })
  @ApiResponse({ status: 201, description: 'Receipt created and signed' })
  @ApiResponse({ status: 400, description: 'Invalid receipt data' })
  create(@Body() dto: CreateReceiptDto) {
    return this.receiptsService.create(dto);
  }

  @Get(':escrowId')
  @ApiOperation({ summary: 'List receipts by escrow ID' })
  @ApiParam({ name: 'escrowId', description: 'Parent escrow session UUID' })
  @ApiResponse({ status: 200, description: 'Receipt list returned' })
  findByEscrow(@Param('escrowId') escrowId: string) {
    return this.receiptsService.findByEscrowId(escrowId);
  }

  @Post('validate')
  @ApiOperation({ summary: 'Validate a receipt signature' })
  @ApiResponse({ status: 200, description: 'Validation result returned' })
  @ApiResponse({ status: 400, description: 'Invalid signature format' })
  validate(@Body() dto: ValidateReceiptDto) {
    return this.receiptsService.validate(dto);
  }
}
