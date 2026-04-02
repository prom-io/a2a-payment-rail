import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsUUID, Min } from 'class-validator';

export class ClaimStreamDto {
  @ApiProperty({ description: 'Parent escrow session ID' })
  @IsUUID('4', { message: 'escrowId must be a valid UUID' })
  escrowId!: string;

  @ApiProperty({ description: 'Incremental usage amount in wei', minimum: 1 })
  @IsNumber()
  @Min(1, { message: 'usageDelta must be positive' })
  usageDelta!: number;
}
