import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { SettlementStatus } from '../entities/settlement.entity';

export enum ExportFormat {
  CSV = 'csv',
  NDJSON = 'ndjson',
}

export class ExportSettlementsQueryDto {
  @ApiProperty({ required: false, enum: ExportFormat, default: ExportFormat.CSV })
  @IsOptional()
  @IsEnum(ExportFormat, { message: 'format must be csv or ndjson' })
  format?: ExportFormat;

  @ApiProperty({ required: false, description: 'Value of X-Next-Cursor from the previous page' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiProperty({ required: false, description: 'Rows per page, default 500, capped at 5000' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiProperty({ required: false, description: 'Only settlements of this escrow' })
  @IsOptional()
  @IsUUID('4', { message: 'escrowId must be a valid UUID' })
  escrowId?: string;

  @ApiProperty({ required: false, enum: SettlementStatus })
  @IsOptional()
  @IsEnum(SettlementStatus)
  status?: SettlementStatus;

  @ApiProperty({ required: false, description: 'Created at or after this ISO-8601 instant' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiProperty({ required: false, description: 'Created before this ISO-8601 instant' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
