import { buildSessionKey, parseSessionKey } from '../src/blockchain/session-key';
import { registerChain } from '../src/blockchain/chain-registry';

describe('multi-chain escrow lifecycle (e2e)', () => {
  beforeAll(() => {
    registerChain({ chainId: 999, name: 'local', rpcUrl: 'http://localhost:8545', confirmations: 1, maxFeePerGasGwei: 1, maxPriorityFeePerGasGwei: 1 });
  });
  it('keys on different chains do not collide', () => {
    const a = buildSessionKey(71234, 'agent-1', 7);
    const b = buildSessionKey(999, 'agent-1', 7);
    expect(a).not.toEqual(b);
    expect(parseSessionKey(a).chainId).toBe(71234);
    expect(parseSessionKey(b).chainId).toBe(999);
  });
});
