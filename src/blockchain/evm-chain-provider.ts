import { JsonRpcProvider } from 'ethers';
import { ChainProvider } from './chain-provider.interface';
import { getChain } from './chain-registry';

// Concrete EVM provider; the rest of the service depends only on ChainProvider,
// so a non-EVM rail can be dropped in without touching the escrow logic.
export class EvmChainProvider implements ChainProvider {
  private readonly provider: JsonRpcProvider;
  constructor(readonly chainId: number) {
    this.provider = new JsonRpcProvider(getChain(chainId).rpcUrl);
  }
  getBlockNumber(): Promise<number> { return this.provider.getBlockNumber(); }
  async waitForConfirmations(txHash: string, confirmations: number): Promise<void> {
    await this.provider.waitForTransaction(txHash, confirmations);
  }
  async sendRaw(signedTx: string): Promise<string> {
    const res = await this.provider.broadcastTransaction(signedTx);
    return res.hash;
  }
}
