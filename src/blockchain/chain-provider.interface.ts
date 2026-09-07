export interface ChainProvider {
  readonly chainId: number;
  getBlockNumber(): Promise<number>;
  waitForConfirmations(txHash: string, confirmations: number): Promise<void>;
  sendRaw(signedTx: string): Promise<string>;
}
