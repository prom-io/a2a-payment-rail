import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { PAUSE_SCOPES } from '../pause.service';

const SCOPE_CHOICES = [...PAUSE_SCOPES, 'all'];

export class ResumeDto {
  @ApiProperty({ enum: SCOPE_CHOICES, description: 'What to act on; "all" means every scope' })
  @IsIn(SCOPE_CHOICES, { message: `scope must be one of: ${SCOPE_CHOICES.join(', ')}` })
  scope!: string;
}

export class PauseDto extends ResumeDto {
  @ApiProperty({ description: 'Why; shown to callers in the 503 and kept in the audit trail' })
  @IsString()
  @MinLength(3)
  @MaxLength(256)
  reason!: string;
}
