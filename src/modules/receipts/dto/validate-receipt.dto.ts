import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class ValidateReceiptDto {
  @ApiProperty()
  @IsString()
  receiptHash!: string;

  @ApiProperty()
  @IsString()
  signature!: string;
}
