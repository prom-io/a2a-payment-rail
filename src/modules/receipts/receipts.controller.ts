import {
  BadRequestException,
  Controller,
  Post,
  Get,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { ReceiptsService } from './receipts.service';
import { CreateReceiptDto } from './dto/create-receipt.dto';
import { ValidateReceiptDto } from './dto/validate-receipt.dto';
import { VerifyProofDto } from './dto/verify-proof.dto';
import { verifyMerkleProof } from './merkle.util';

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

  @Get('proof/:receiptHash')
  @ApiOperation({ summary: 'Merkle inclusion proof of a receipt in its settlement batch' })
  @ApiParam({ name: 'receiptHash', description: 'Keccak-256 hash of the receipt' })
  @ApiResponse({ status: 200, description: 'Root, leaf index and sibling hashes' })
  @ApiResponse({ status: 404, description: 'Receipt not found' })
  @ApiResponse({ status: 409, description: 'Receipt is not batched into a settlement yet' })
  proof(@Param('receiptHash') receiptHash: string) {
    if (!/^0x[a-fA-F0-9]{64}$/.test(receiptHash)) {
      throw new BadRequestException('receiptHash must be a valid keccak-256 hex string');
    }
    return this.receiptsService.inclusionProof(receiptHash);
  }

  @Post('proof/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check an inclusion proof against a batch root' })
  @ApiResponse({ status: 200, description: 'Whether the proof links the receipt to the root' })
  verifyProof(@Body() dto: VerifyProofDto) {
    return { valid: verifyMerkleProof(dto.receiptHash, dto.proof, dto.root) };
  }

  @Post('validate')
  @ApiOperation({ summary: 'Validate a receipt signature' })
  @ApiResponse({ status: 200, description: 'Validation result returned' })
  @ApiResponse({ status: 400, description: 'Invalid signature format' })
  validate(@Body() dto: ValidateReceiptDto) {
    return this.receiptsService.validate(dto);
  }
}
