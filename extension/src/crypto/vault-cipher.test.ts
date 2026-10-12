import { describe, expect, it } from 'vitest';
import { doc } from '../../test/builders';
import { ROOT_TOOLBAR } from '../model/vault';
import { CryptoError } from './errors';
import { decryptVault, encryptVault, hasVaultMagic } from './vault-cipher';

const key = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
const sample = () => doc({ [ROOT_TOOLBAR]: [{ b: 'a' }, { f: 'f', children: [{ b: 'b', title: 'Ünïcødé 📚' }] }] }, 5);

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof CryptoError && e.code === code);
}

describe('vault cipher', () => {
  it('round-trips a document', async () => {
    const k = await key();
    const env = await encryptVault(sample(), k, 'alice');
    expect(hasVaultMagic(env)).toBe(true);
    expect(await decryptVault(env, k, 'alice')).toEqual(sample());
  });

  it('never reveals plaintext and is not a bare gzip stream', async () => {
    const env = await encryptVault(sample(), await key(), 'alice');
    expect(Buffer.from(env).includes('a.example')).toBe(false);
    expect([env[16], env[17]]).not.toEqual([0x1f, 0x8b]);
  });

  it('uses a fresh IV each time', async () => {
    const k = await key();
    const a = await encryptVault(sample(), k, 'alice');
    const b = await encryptVault(sample(), k, 'alice');
    expect(Buffer.from(a.subarray(4, 16)).equals(Buffer.from(b.subarray(4, 16)))).toBe(false);
  });

  it('detects tampering anywhere after the magic', async () => {
    const k = await key();
    const env = await encryptVault(sample(), k, 'alice');
    for (const pos of [4, 15, 16, env.length - 1]) {
      const t = env.slice();
      t[pos]! ^= 1;
      await expectCode(decryptVault(t, k, 'alice'), 'auth_failed');
    }
  });

  it('binds the ciphertext to the username and the key', async () => {
    const k = await key();
    const env = await encryptVault(sample(), k, 'alice');
    await expectCode(decryptVault(env, k, 'bob'), 'auth_failed');
    await expectCode(decryptVault(env, await key(), 'alice'), 'auth_failed');
  });

  it('rejects non-vault input', async () => {
    const k = await key();
    await expectCode(decryptVault(new TextEncoder().encode('NOPE' + 'x'.repeat(40)), k, 'alice'), 'bad_magic');
    await expectCode(decryptVault(new TextEncoder().encode('BSV1'), k, 'alice'), 'bad_magic');
  });
});
