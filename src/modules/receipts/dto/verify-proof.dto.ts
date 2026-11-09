import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';

const HASH = /^0x[a-fA-F0-9]{64}$/;

export class AttestationDto {
  @ApiProperty({ description: 'The signed message, exactly as returned with the proof' })
  @IsString()
  @MaxLength(1024)
  message!: string;

  @ApiProperty({ description: '65-byte signature of the message' })
  @Matches(/^0x[a-fA-F0-9]{130}$/, { message: 'signature must be a 65-byte hex signature' })
  signature!: string;
}

export class VerifyProofDto {
  @ApiProperty({ description: 'Receipt hash whose inclusion is being checked' })
  @Matches(HASH, { message: 'receiptHash must be a valid keccak-256 hex string' })
  receiptHash!: string;

  @ApiProperty({ description: 'Sibling hashes from the leaf up to the root', type: [String] })
  @IsArray()
  // 64 levels cover any batch that could ever exist; anything longer is abuse.
  @ArrayMaxSize(64)
  @Matches(HASH, { each: true, message: 'every proof element must be a keccak-256 hex string' })
  proof!: string[];

  @ApiProperty({ description: 'Merkle root of the batch (settlement.receiptsHash)' })
  @Matches(HASH, { message: 'root must be a valid keccak-256 hex string' })
  root!: string;

  @ApiProperty({ required: false, type: AttestationDto, description: 'Attestation returned with the proof' })
  @IsOptional()
  @ValidateNested()
  @Type(() => AttestationDto)
  attestation?: AttestationDto;
}
