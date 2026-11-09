import { registerAs } from '@nestjs/config';

export default registerAs('blockchain', () => ({
  rpcUrl: process.env.BLOCKCHAIN_RPC_URL || 'http://localhost:8545',
  privateKey:
    process.env.BLOCKCHAIN_PRIVATE_KEY ||
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  // Signer rotation, see SignerKeyringService. All three are optional.
  previousPrivateKey: process.env.BLOCKCHAIN_PREVIOUS_PRIVATE_KEY ?? '',
  signerRotatedAt: process.env.SIGNER_ROTATED_AT ?? '',
  signerOverlapSeconds: Number(process.env.SIGNER_OVERLAP_SECONDS ?? 86_400),
}));
