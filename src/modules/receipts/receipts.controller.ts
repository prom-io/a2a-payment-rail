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
import { SignerKeyringService } from '../../common/blockchain/signer-keyring.service';

@ApiTags('receipts')
@Controller('receipts')
export class ReceiptsController {
  constructor(
    private readonly receiptsService: ReceiptsService,
    private readonly keyring: SignerKeyringService,
  ) {}

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
  @ApiResponse({ status: 200, description: 'Root, leaf index, sibling hashes and the rail\'s attestation of the root' })
  @ApiResponse({ status: 404, description: 'Receipt not found' })
  @ApiResponse({ status: 409, description: 'Receipt is not batched into a settlement yet' })
  async proof(@Param('receiptHash') receiptHash: string) {
    if (!/^0x[a-fA-F0-9]{64}$/.test(receiptHash)) {
      throw new BadRequestException('receiptHash must be a valid keccak-256 hex string');
    }
    const proof = await this.receiptsService.inclusionProof(receiptHash);
    // The proof ties the receipt to a root; the attestation ties the root to the rail.
    const attestation = await this.keyring.attest('receipt-batch-root', {
      settlementId: proof.settlementId,
      root: proof.root,
      leafCount: proof.leafCount,
    });
    return { ...proof, attestation };
  }

  @Post('proof/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check an inclusion proof against a batch root' })
  @ApiResponse({ status: 200, description: 'Whether the proof links the receipt to the root' })
  verifyProof(@Body() dto: VerifyProofDto) {
    const valid = verifyMerkleProof(dto.receiptHash, dto.proof, dto.root);
    if (!dto.attestation) return { valid };
    // An attestation only counts for the root it names: the signed message carries it.
    const check = this.keyring.verify(dto.attestation.message, dto.attestation.signature);
    const namesRoot = dto.attestation.message.includes(`root=${dto.root.toLowerCase()}`);
    return {
      valid,
      attestation: namesRoot ? check : { valid: false, signer: check.signer, role: null, reason: 'root_mismatch' },
    };
  }

  @Post('validate')
  @ApiOperation({ summary: 'Validate a receipt signature' })
  @ApiResponse({ status: 200, description: 'Validation result returned' })
  @ApiResponse({ status: 400, description: 'Invalid signature format' })
  validate(@Body() dto: ValidateReceiptDto) {
    return this.receiptsService.validate(dto);
  }
}
