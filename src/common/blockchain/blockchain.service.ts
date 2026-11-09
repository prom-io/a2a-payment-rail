import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { SignerKeyringService } from './signer-keyring.service';

/** The part of a sent transaction the service needs in order to wait for it. */
export interface WaitableTransaction {
  hash: string;
  wait(confirmations?: number, timeoutMs?: number): Promise<ethers.TransactionReceipt | null>;
}

const GWEI = 10n ** 9n;

@Injectable()
export class BlockchainService implements OnModuleInit {
  private readonly logger = new Logger(BlockchainService.name);
  private provider!: ethers.JsonRpcProvider;
  private wallet!: ethers.Wallet;
  private requiredConfirmations = 1;
  private confirmationTimeoutMs = 0;
  private maxFeePerGasWei = 0n;

  constructor(
    private readonly configService: ConfigService,
    private readonly keyring: SignerKeyringService,
  ) {}

  onModuleInit() {
    const rpcUrl = this.configService.get<string>('blockchain.rpcUrl', 'http://localhost:8545');
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    // Transactions are always signed by the keyring's current key; a key that
    // is being rotated out is never used to send anything.
    this.wallet = new ethers.Wallet(this.keyring.currentPrivateKey, this.provider);

    // Finality and fee limits come from the network profile (network.config.ts).
    this.requiredConfirmations = Math.max(this.configService.get<number>('network.confirmations', 1), 1);
    this.confirmationTimeoutMs = this.configService.get<number>('network.confirmationTimeoutMs', 0);
    const maxFeeGwei = this.configService.get<number>('network.maxFeePerGasGwei', 0);
    this.maxFeePerGasWei = BigInt(Math.round(maxFeeGwei * 1e9));

    this.logger.log(
      `Blockchain connected: ${rpcUrl}, wallet: ${this.wallet.address}, ` +
        `profile: ${this.configService.get<string>('network.name', 'local')}, ` +
        `confirmations: ${this.requiredConfirmations}`,
    );
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

  /** Blocks a transaction must be buried under before the rail calls it final. */
  get confirmations(): number {
    return this.requiredConfirmations;
  }

  /**
   * Waits until `tx` has the confirmations the network profile asks for.
   * Rejects with ethers' TIMEOUT error when the profile's ceiling passes first;
   * the transaction may still be mined later, so callers keep its hash.
   */
  async waitFor(tx: WaitableTransaction): Promise<ethers.TransactionReceipt> {
    const receipt = await tx.wait(this.requiredConfirmations, this.confirmationTimeoutMs);
    if (!receipt) throw new Error(`Transaction ${tx.hash} has no receipt`);
    return receipt;
  }

  /**
   * Refuses to send while the network fee is above the profile's cap. The
   * error is transient on purpose: callers with a retry queue try again later,
   * when the spike is over, instead of paying it.
   */
  async assertGasWithinCap(): Promise<void> {
    if (this.maxFeePerGasWei === 0n) return;
    const fees = await this.provider.getFeeData();
    const current = fees.maxFeePerGas ?? fees.gasPrice;
    if (current !== null && current > this.maxFeePerGasWei) {
      throw Object.assign(
        new Error(
          `Network fee ${current / GWEI} gwei is above the cap of ${this.maxFeePerGasWei / GWEI} gwei`,
        ),
        { code: 'GAS_PRICE_ABOVE_CAP' },
      );
    }
  }
}
