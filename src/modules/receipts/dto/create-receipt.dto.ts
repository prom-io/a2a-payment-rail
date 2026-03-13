import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber } from 'class-validator';

export class CreateReceiptDto {
  @ApiProperty()
  @IsString()
  escrowId!: string;

  @ApiProperty()
  @IsString()
  sessionId!: string;

  @ApiProperty()
  @IsString()
  fromAgent!: string;

  @ApiProperty()
  @IsString()
  toAgent!: string;

  @ApiProperty()
  @IsNumber()
  amount!: number;

  @ApiProperty()
  @IsString()
  receiptHash!: string;

  @ApiProperty()
  @IsString()
  signature!: string;
}
