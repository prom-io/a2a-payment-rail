import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class ValidateReceiptDto {
  @ApiProperty({ description: 'Keccak-256 hash of receipt payload' })
  @IsString()
  @Matches(/^0x[a-fA-F0-9]{64}$/, { message: 'receiptHash must be a valid keccak-256 hex string' })
  receiptHash!: string;

  @ApiProperty({ description: 'ECDSA signature to verify' })
  @IsString()
  @Matches(/^0x[a-fA-F0-9]{130}$/, { message: 'signature must be a valid ECDSA signature (65 bytes hex)' })
  signature!: string;
}
