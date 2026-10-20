import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class ReleaseEscrowDto {
  @ApiProperty({ description: 'Amount to release to the payee, decimal string', example: '0.25' })
  @IsString()
  @Matches(/^\d{1,18}(\.\d{1,18})?$/, {
    message: 'amount must be a positive decimal string with up to 18 decimals',
  })
  amount!: string;

  @ApiProperty({ required: false, description: 'What the release is for (milestone, invoice ...)' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  note?: string;
}
