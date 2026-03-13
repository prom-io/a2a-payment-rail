import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber } from 'class-validator';

export class SettleBatchDto {
  @ApiProperty()
  @IsString()
  escrowId!: string;

  @ApiProperty()
  @IsString()
  receiptsHash!: string;

  @ApiProperty()
  @IsNumber()
  totalAmount!: number;
}
