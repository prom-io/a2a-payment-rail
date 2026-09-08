import { getChain } from './chain-registry';

// Session keys embed the chain id so escrow on different chains never collides.
export function buildSessionKey(chainId: number, agentId: string, nonce: number): string {
  const c = getChain(chainId);
  return `${c.name}:${chainId}:${agentId}:${nonce}`;
}

export function parseSessionKey(key: string): { chainId: number; agentId: string; nonce: number } {
  const [, chainId, agentId, nonce] = key.split(':');
  return { chainId: Number(chainId), agentId, nonce: Number(nonce) };
}
