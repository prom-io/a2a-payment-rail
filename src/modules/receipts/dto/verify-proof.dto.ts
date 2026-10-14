import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, Matches } from 'class-validator';

const HASH = /^0x[a-fA-F0-9]{64}$/;

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
}
