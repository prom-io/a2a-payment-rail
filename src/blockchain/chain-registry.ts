export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  confirmations: number;
  maxFeePerGasGwei: number;
  maxPriorityFeePerGasGwei: number;
}

const REGISTRY: Record<number, ChainConfig> = {
  71234: {
    chainId: 71234,
    name: 'prom-testnet',
    rpcUrl: process.env.PROM_TESTNET_RPC_URL ?? '',
    confirmations: 1,
    maxFeePerGasGwei: 5,
    maxPriorityFeePerGasGwei: 1,
  },
};

export function getChain(chainId: number): ChainConfig {
  const c = REGISTRY[chainId];
  if (!c) throw new Error(`Unknown chain ${chainId}`);
  return c;
}

export function registerChain(cfg: ChainConfig): void {
  REGISTRY[cfg.chainId] = cfg;
}
