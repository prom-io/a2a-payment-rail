import { ApiProperty } from '@nestjs/swagger';
import {
  IsEthereumAddress,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class WithdrawFeesDto {
  @ApiProperty({ description: 'Amount to withdraw, decimal string in the native token', example: '0.25' })
  @IsString()
  @Matches(/^\d{1,18}(\.\d{1,18})?$/, {
    message: 'amount must be a positive decimal string with up to 18 decimals',
  })
  amount!: string;

  @ApiProperty({ description: 'Treasury address the fees are paid out to' })
  @IsEthereumAddress({ message: 'recipient must be a valid Ethereum address' })
  recipient!: string;

  @ApiProperty({ required: false, description: 'Chain to withdraw from; defaults to the configured chain' })
  @IsOptional()
  @IsInt()
  @Min(1)
  chainId?: number;

  @ApiProperty({ required: false, description: 'Hash of the on-chain payout, when it is already known' })
  @IsOptional()
  @Matches(/^0x[a-fA-F0-9]{64}$/, { message: 'txHash must be a 0x-prefixed 32-byte hex string' })
  txHash?: string;

  @ApiProperty({ required: false, description: 'Free-form reference for the audit trail' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  note?: string;
}
