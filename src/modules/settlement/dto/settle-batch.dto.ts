import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, IsUUID, Min, Matches } from 'class-validator';

export class SettleBatchDto {
  @ApiProperty({ description: 'Parent escrow session ID' })
  @IsUUID('4', { message: 'escrowId must be a valid UUID' })
  escrowId!: string;

  @ApiProperty({ description: 'Merkle root hash of the receipts batch' })
  @IsString()
  @Matches(/^0x[a-fA-F0-9]{64}$/, { message: 'receiptsHash must be a valid keccak-256 hex string' })
  receiptsHash!: string;

  @ApiProperty({ description: 'Total settlement amount in wei', minimum: 1 })
  @IsNumber()
  @Min(1, { message: 'totalAmount must be at least 1 wei' })
  totalAmount!: number;
}
