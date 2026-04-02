import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, IsNotEmpty, IsUUID, Min, IsEthereumAddress, Matches } from 'class-validator';

export class CreateReceiptDto {
  @ApiProperty({ description: 'Parent escrow session ID' })
  @IsUUID('4', { message: 'escrowId must be a valid UUID' })
  escrowId!: string;

  @ApiProperty({ description: 'Streaming session ID' })
  @IsUUID('4', { message: 'sessionId must be a valid UUID' })
  sessionId!: string;

  @ApiProperty({ description: 'Sender agent Ethereum address' })
  @IsString()
  @IsNotEmpty()
  @IsEthereumAddress({ message: 'fromAgent must be a valid Ethereum address' })
  fromAgent!: string;

  @ApiProperty({ description: 'Receiver agent Ethereum address' })
  @IsString()
  @IsNotEmpty()
  @IsEthereumAddress({ message: 'toAgent must be a valid Ethereum address' })
  toAgent!: string;

  @ApiProperty({ description: 'Payment amount in wei', minimum: 0 })
  @IsNumber()
  @Min(0, { message: 'amount must be non-negative' })
  amount!: number;

  @ApiProperty({ description: 'Keccak-256 hash of receipt payload' })
  @IsString()
  @Matches(/^0x[a-fA-F0-9]{64}$/, { message: 'receiptHash must be a valid keccak-256 hex string' })
  receiptHash!: string;

  @ApiProperty({ description: 'ECDSA signature of the receipt hash' })
  @IsString()
  @Matches(/^0x[a-fA-F0-9]{130}$/, { message: 'signature must be a valid ECDSA signature (65 bytes hex)' })
  signature!: string;
}
