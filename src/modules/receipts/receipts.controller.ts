import { Controller, Post, Get, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ReceiptsService } from './receipts.service';
import { CreateReceiptDto } from './dto/create-receipt.dto';
import { ValidateReceiptDto } from './dto/validate-receipt.dto';

@ApiTags('receipts')
@Controller('receipts')
export class ReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a payment receipt' })
  create(@Body() dto: CreateReceiptDto) {
    return this.receiptsService.create(dto);
  }

  @Get(':escrowId')
  @ApiOperation({ summary: 'List receipts by escrow ID' })
  findByEscrow(@Param('escrowId') escrowId: string) {
    return this.receiptsService.findByEscrowId(escrowId);
  }

  @Post('validate')
  @ApiOperation({ summary: 'Validate a receipt signature' })
  validate(@Body() dto: ValidateReceiptDto) {
    return this.receiptsService.validate(dto);
  }
}
