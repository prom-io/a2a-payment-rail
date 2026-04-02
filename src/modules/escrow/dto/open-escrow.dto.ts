import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsBoolean,
  IsOptional,
  IsObject,
  IsNotEmpty,
  IsEthereumAddress,
  Min,
  Max,
} from 'class-validator';

export class OpenEscrowDto {
  @ApiProperty({ description: 'Ethereum address of agent A (payer)' })
  @IsString()
  @IsNotEmpty({ message: 'agentA address is required' })
  @IsEthereumAddress({ message: 'agentA must be a valid Ethereum address' })
  agentA!: string;

  @ApiProperty({ description: 'Ethereum address of agent B (payee)' })
  @IsString()
  @IsNotEmpty({ message: 'agentB address is required' })
  @IsEthereumAddress({ message: 'agentB must be a valid Ethereum address' })
  agentB!: string;

  @ApiProperty({ description: 'Initial deposit in wei', minimum: 1 })
  @IsNumber()
  @Min(1, { message: 'depositAmount must be at least 1 wei' })
  depositAmount!: number;

  @ApiProperty({ description: 'Maximum budget for the session in wei', minimum: 1 })
  @IsNumber()
  @Min(1, { message: 'budgetLimit must be positive' })
  budgetLimit!: number;

  @ApiProperty({ required: false, description: 'Optional policy flags for verification' })
  @IsObject()
  @IsOptional()
  policyFlags?: Record<string, unknown>;

  @ApiProperty({ required: false, default: false })
  @IsBoolean()
  @IsOptional()
  verificationRequired?: boolean;

  @ApiProperty({ description: 'Session time-to-live in seconds', minimum: 60, maximum: 604800 })
  @IsNumber()
  @Min(60, { message: 'TTL must be at least 60 seconds' })
  @Max(604800, { message: 'TTL cannot exceed 7 days (604800s)' })
  ttl!: number;
}
