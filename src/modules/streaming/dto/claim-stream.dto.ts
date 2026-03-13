import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber } from 'class-validator';

export class ClaimStreamDto {
  @ApiProperty()
  @IsString()
  escrowId!: string;

  @ApiProperty()
  @IsNumber()
  usageDelta!: number;
}
