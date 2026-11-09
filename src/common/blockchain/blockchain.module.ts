import { Global, Module } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import { SignerKeyringService } from './signer-keyring.service';

@Global()
@Module({
  providers: [BlockchainService, SignerKeyringService],
  exports: [BlockchainService, SignerKeyringService],
})
export class BlockchainModule {}
