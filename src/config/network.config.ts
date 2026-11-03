import { registerAs } from '@nestjs/config';
import { registerChain } from '../blockchain/chain-registry';

export type NetworkProfileName = 'local' | 'testnet' | 'mainnet';

export interface NetworkProfile {
  name: NetworkProfileName;
  /** Name the chain is registered under in the chain registry. */
  chainName: string;
  /** Blocks on top of a transaction before the rail treats it as final. */
  confirmations: number;
  /** How long to wait for those blocks before the attempt counts as timed out; 0 waits forever. */
  confirmationTimeoutMs: number;
  /** Refuse to send while the network asks for more than this; 0 disables the cap. */
  maxFeePerGasGwei: number;
  maxPriorityFeePerGasGwei: number;
}

/**
 * Network profiles. `NETWORK_PROFILE` picks one; the default is `local`.
 *
 *   local    anvil on a laptop: one block is final, nothing is capped.
 *   testnet  prom-testnet: same numbers as its chain-registry entry, plus a
 *            timeout so a stuck RPC cannot hold a request forever.
 *   mainnet  real value. Twelve confirmations before a payout counts as
 *            settled (a reorg deeper than that is not an operational event
 *            any more), a ten-minute ceiling on the wait, and a fee cap so a
 *            gas spike delays settlements instead of draining the signer.
 *
 * The four numbers can be overridden one by one (TX_CONFIRMATIONS,
 * TX_CONFIRMATION_TIMEOUT_MS, MAX_FEE_PER_GAS_GWEI,
 * MAX_PRIORITY_FEE_PER_GAS_GWEI) when a chain needs different values.
 */
export const NETWORK_PROFILES: Record<NetworkProfileName, NetworkProfile> = {
  local: {
    name: 'local',
    chainName: 'local',
    confirmations: 1,
    confirmationTimeoutMs: 0,
    maxFeePerGasGwei: 0,
    maxPriorityFeePerGasGwei: 0,
  },
  testnet: {
    name: 'testnet',
    chainName: 'prom-testnet',
    confirmations: 1,
    confirmationTimeoutMs: 120_000,
    maxFeePerGasGwei: 5,
    maxPriorityFeePerGasGwei: 1,
  },
  mainnet: {
    name: 'mainnet',
    chainName: 'prom-mainnet',
    confirmations: 12,
    confirmationTimeoutMs: 600_000,
    maxFeePerGasGwei: 50,
    maxPriorityFeePerGasGwei: 2,
  },
};

type Env = Record<string, string | undefined>;

function numberFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveNetworkProfile(env: Env = process.env): NetworkProfile {
  const name = (env.NETWORK_PROFILE ?? 'local').trim().toLowerCase();
  if (!(name in NETWORK_PROFILES)) {
    // An unknown profile must not quietly become "local" with one confirmation.
    throw new Error(
      `NETWORK_PROFILE "${env.NETWORK_PROFILE}" is not one of: ${Object.keys(NETWORK_PROFILES).join(', ')}`,
    );
  }
  const base = NETWORK_PROFILES[name as NetworkProfileName];
  return {
    ...base,
    confirmations: Math.floor(numberFromEnv(env.TX_CONFIRMATIONS, base.confirmations)),
    confirmationTimeoutMs: Math.floor(
      numberFromEnv(env.TX_CONFIRMATION_TIMEOUT_MS, base.confirmationTimeoutMs),
    ),
    maxFeePerGasGwei: numberFromEnv(env.MAX_FEE_PER_GAS_GWEI, base.maxFeePerGasGwei),
    maxPriorityFeePerGasGwei: numberFromEnv(
      env.MAX_PRIORITY_FEE_PER_GAS_GWEI,
      base.maxPriorityFeePerGasGwei,
    ),
  };
}

export default registerAs('network', () => {
  const profile = resolveNetworkProfile();
  const chainId = parseInt(process.env.CHAIN_ID ?? '', 10);
  // Make the configured chain known to the chain registry under its profile
  // name. The testnet entry is built in; local and mainnet are registered here
  // from the same variables the signer uses.
  if (Number.isInteger(chainId) && chainId > 0 && profile.name !== 'testnet') {
    registerChain({
      chainId,
      name: profile.chainName,
      rpcUrl: process.env.BLOCKCHAIN_RPC_URL ?? '',
      confirmations: profile.confirmations,
      maxFeePerGasGwei: profile.maxFeePerGasGwei,
      maxPriorityFeePerGasGwei: profile.maxPriorityFeePerGasGwei,
    });
  }
  return profile;
});
