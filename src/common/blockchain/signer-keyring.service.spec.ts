import { ethers } from 'ethers';
import { configStub } from '../../testing/stubs';
import { SignerKeyringService } from './signer-keyring.service';

const OLD_KEY = '0x' + '11'.repeat(32);
const NEW_KEY = '0x' + '22'.repeat(32);
const OLD = new ethers.Wallet(OLD_KEY);
const NEW = new ethers.Wallet(NEW_KEY);
const ROTATED_AT = new Date('2026-06-01T00:00:00.000Z');
const hoursAfterRotation = (hours: number) => new Date(ROTATED_AT.getTime() + hours * 3_600_000);

function keyring(config: Record<string, unknown> = {}) {
  return new SignerKeyringService(configStub({ 'blockchain.privateKey': NEW_KEY, ...config }));
}

function rotating(overlapSeconds = 86_400) {
  return keyring({
    'blockchain.previousPrivateKey': OLD_KEY,
    'blockchain.signerRotatedAt': ROTATED_AT.toISOString(),
    'blockchain.signerOverlapSeconds': overlapSeconds,
  });
}

describe('SignerKeyringService', () => {
  describe('without a rotation', () => {
    it('has one signer and no window', () => {
      const ring = keyring();

      expect(ring.currentAddress).toBe(NEW.address);
      expect(ring.currentPrivateKey).toBe(NEW_KEY);
      expect(ring.overlapEndsAt()).toBeNull();
      expect(ring.roleOf(NEW.address)).toBe('current');
      expect(ring.roleOf(OLD.address)).toBeNull();
      expect(ring.status()).toEqual({
        current: { address: NEW.address },
        previous: null,
        overlapSeconds: 86_400,
      });
    });

    it('recognises its address in any letter case and rejects garbage', () => {
      const ring = keyring();
      expect(ring.roleOf(NEW.address.toLowerCase())).toBe('current');
      expect(ring.roleOf('not-an-address')).toBeNull();
    });
  });

  describe('during a rotation', () => {
    it('signs with the new key only', async () => {
      const ring = rotating();
      const attestation = await ring.attest('receipt-batch-root', { root: '0xabc', leafCount: 3 });

      expect(ring.currentPrivateKey).toBe(NEW_KEY);
      expect(attestation.signer).toBe(NEW.address);
      expect(ethers.verifyMessage(attestation.message, attestation.signature)).toBe(NEW.address);
    });

    it('accepts the previous key until the overlap ends, to the millisecond', () => {
      const ring = rotating();
      const end = hoursAfterRotation(24);

      expect(ring.overlapEndsAt()).toEqual(end);
      expect(ring.roleOf(OLD.address, hoursAfterRotation(0))).toBe('previous');
      expect(ring.roleOf(OLD.address, new Date(end.getTime() - 1))).toBe('previous');
      expect(ring.roleOf(OLD.address, end)).toBeNull();
      expect(ring.roleOf(OLD.address, hoursAfterRotation(48))).toBeNull();
      // the current key is never subject to the window
      expect(ring.roleOf(NEW.address, hoursAfterRotation(1000))).toBe('current');
    });

    it('verifies what the previous key signed inside the window and refuses it afterwards', async () => {
      const ring = rotating();
      const message = 'prom-payment-rail:v1:receipt-batch-root:root=0xabc:2026-05-31T23:59:00.000Z';
      const signature = await OLD.signMessage(message);

      expect(ring.verify(message, signature, hoursAfterRotation(23))).toEqual({
        valid: true,
        signer: OLD.address,
        role: 'previous',
      });
      expect(ring.verify(message, signature, hoursAfterRotation(25))).toEqual({
        valid: false,
        signer: OLD.address,
        role: null,
        reason: 'previous_signer_expired',
      });
    });

    it('honours a custom overlap, including none at all', () => {
      expect(rotating(3_600).roleOf(OLD.address, hoursAfterRotation(0.99))).toBe('previous');
      expect(rotating(3_600).roleOf(OLD.address, hoursAfterRotation(1.01))).toBeNull();
      expect(rotating(0).roleOf(OLD.address, ROTATED_AT)).toBeNull();
    });

    it('reports the rotation in its status', () => {
      const ring = rotating();

      expect(ring.status(hoursAfterRotation(1))).toEqual({
        current: { address: NEW.address },
        previous: {
          address: OLD.address,
          rotatedAt: ROTATED_AT.toISOString(),
          acceptedUntil: hoursAfterRotation(24).toISOString(),
          accepted: true,
        },
        overlapSeconds: 86_400,
      });
      expect(ring.status(hoursAfterRotation(30)).previous!.accepted).toBe(false);
    });
  });

  describe('attestations', () => {
    it('signs a canonical message that does not depend on key order', async () => {
      const ring = keyring();
      const now = new Date('2026-06-02T10:00:00.000Z');

      const a = await ring.attest('receipt-batch-root', { settlementId: 's1', root: '0xabc' }, now);
      const b = await ring.attest('receipt-batch-root', { root: '0xabc', settlementId: 's1' }, now);

      expect(a.message).toBe(
        'prom-payment-rail:v1:receipt-batch-root:root=0xabc&settlementId=s1:2026-06-02T10:00:00.000Z',
      );
      expect(b).toEqual(a);
      expect(ring.verify(a.message, a.signature)).toEqual({ valid: true, signer: NEW.address, role: 'current' });
    });

    it('rejects a foreign signer, a changed message and a malformed signature', async () => {
      const ring = keyring();
      const attestation = await ring.attest('receipt-batch-root', { root: '0xabc' });
      const stranger = await new ethers.Wallet('0x' + '33'.repeat(32)).signMessage(attestation.message);

      expect(ring.verify(attestation.message, stranger)).toMatchObject({ valid: false, reason: 'unknown_signer' });
      expect(ring.verify(attestation.message + 'x', attestation.signature)).toMatchObject({
        valid: false,
        reason: 'unknown_signer',
      });
      expect(ring.verify(attestation.message, '0x1234')).toEqual({
        valid: false,
        signer: null,
        role: null,
        reason: 'malformed',
      });
    });
  });

  describe('configuration errors', () => {
    it('needs the instant of the rotation when a previous key is configured', () => {
      expect(() => keyring({ 'blockchain.previousPrivateKey': OLD_KEY })).toThrow(/SIGNER_ROTATED_AT/);
      expect(() =>
        keyring({ 'blockchain.previousPrivateKey': OLD_KEY, 'blockchain.signerRotatedAt': 'last tuesday' }),
      ).toThrow(/SIGNER_ROTATED_AT/);
    });

    it('refuses a rotation instant without a previous key', () => {
      expect(() => keyring({ 'blockchain.signerRotatedAt': ROTATED_AT.toISOString() })).toThrow(
        /BLOCKCHAIN_PREVIOUS_PRIVATE_KEY is not/,
      );
    });

    it('refuses the same key twice and a negative overlap', () => {
      expect(() =>
        keyring({ 'blockchain.previousPrivateKey': NEW_KEY, 'blockchain.signerRotatedAt': ROTATED_AT.toISOString() }),
      ).toThrow(/same key/);
      expect(() => keyring({ 'blockchain.signerOverlapSeconds': -1 })).toThrow(/SIGNER_OVERLAP_SECONDS/);
    });

    it('never echoes a malformed key in the error', () => {
      const typo = '0x' + '22'.repeat(31) + 'zz';
      expect(() => keyring({ 'blockchain.privateKey': typo })).toThrow('BLOCKCHAIN_PRIVATE_KEY is not a valid private key');
      try {
        keyring({ 'blockchain.privateKey': typo });
      } catch (error) {
        expect((error as Error).message).not.toContain('2222');
      }
    });
  });
});
