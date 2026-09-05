import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, IsOptional, MaxLength } from 'class-validator';

export class RefundStreamDto {
  @ApiProperty({ description: 'Escrow session UUID' })
  @IsUUID('4', { message: 'escrowId must be a valid UUID v4' })
  escrowId!: string;

  @ApiProperty({ description: 'Reason code for early termination', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  reason?: string;
}

export interface RefundResult {
  escrowId: string;
  totalDeposited: string;
  totalClaimed: string;
  refundAmount: string;
  refundedAt: string;
  reason?: string;
}
