import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsBoolean,
  IsOptional,
  IsObject,
} from 'class-validator';

export class OpenEscrowDto {
  @ApiProperty()
  @IsString()
  agentA!: string;

  @ApiProperty()
  @IsString()
  agentB!: string;

  @ApiProperty()
  @IsNumber()
  depositAmount!: number;

  @ApiProperty()
  @IsNumber()
  budgetLimit!: number;

  @ApiProperty({ required: false })
  @IsObject()
  @IsOptional()
  policyFlags?: Record<string, unknown>;

  @ApiProperty({ required: false, default: false })
  @IsBoolean()
  @IsOptional()
  verificationRequired?: boolean;

  @ApiProperty({ description: 'Time-to-live in seconds' })
  @IsNumber()
  ttl!: number;
}
