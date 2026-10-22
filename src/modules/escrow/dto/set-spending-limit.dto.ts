import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class SetSpendingLimitDto {
  @ApiProperty({
    description: 'Maximum total deposit per rolling window, decimal string; "0" means unlimited',
    example: '25',
  })
  @IsString()
  @Matches(/^\d{1,18}(\.\d{1,18})?$/, {
    message: 'dailyLimit must be a non-negative decimal string with up to 18 decimals',
  })
  dailyLimit!: string;
}
