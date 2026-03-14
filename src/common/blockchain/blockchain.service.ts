import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';

@Injectable()
export class BlockchainService implements OnModuleInit {
  private readonly logger = new Logger(BlockchainService.name);
  private provider!: ethers.JsonRpcProvider;
  private wallet!: ethers.Wallet;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const rpcUrl = this.configService.get<string>('blockchain.rpcUrl', 'http://localhost:8545');
    const privateKey = this.configService.get<string>(
      'blockchain.privateKey',
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.logger.log(`Blockchain connected: ${rpcUrl}, wallet: ${this.wallet.address}`);
  }

  getProvider(): ethers.JsonRpcProvider { return this.provider; }
  getWallet(): ethers.Wallet { return this.wallet; }

  getContract(address: string, abi: ethers.InterfaceAbi): ethers.Contract {
    return new ethers.Contract(address, abi, this.wallet);
  }

  async getWalletAddress(): Promise<string> { return this.wallet.address; }

  hashData(data: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(data));
  }
}
