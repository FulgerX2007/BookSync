import { describe, expect, it } from 'vitest';
import { CryptoError, bytes, utf8 } from './errors';
import {
  KDF_NAME,
  MIN_ITERATIONS,
  assertKdfParams,
  createVaultKey,
  deriveKeys,
  isValidUsername,
  normalizeUsername,
  rewrapVaultKey,
  unwrapVaultKey,
} from './keys';

const sid = Uint8Array.from({ length: 16 }, (_, i) => i);
const PW = 'correct horse battery staple';
const fast = { allowWeak: true };
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

// Computed independently with Python's hashlib.pbkdf2_hmac + RFC 5869 HKDF
// (docs/protocol.md §1.2; Task 13 notes in docs/plans/completed/).
const VECTOR = {
  authKey: 'bb4e76c9004b496b6e50c1845c3a1a3ee6d695c95f1dbef3a76cd6b1213dd01d',
  kek: 'bf7ae07aff0552d9d1f011eae6d27296ea6897b14c47fd28b5cb767a6192829b',
};

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof CryptoError && e.code === code);
}

describe('usernames', () => {
  it('normalizes like the server', () => {
    expect(normalizeUsername('  Alice ')).toBe('alice');
    expect(isValidUsername('alice')).toBe(true);
    expect(isValidUsername('al')).toBe(false);
    expect(isValidUsername('a b c')).toBe(false);
  });
});

describe('assertKdfParams', () => {
  it('accepts our parameters', () => {
    expect(() => assertKdfParams(KDF_NAME, MIN_ITERATIONS)).not.toThrow();
  });
  it.each([
    ['low iterations', KDF_NAME, 1],
    ['just below minimum', KDF_NAME, MIN_ITERATIONS - 1],
    ['absurd iterations', KDF_NAME, 1e12],
    ['other kdf', 'md5', MIN_ITERATIONS],
    ['fractional', KDF_NAME, MIN_ITERATIONS + 0.5],
  ])('rejects %s', (_n, kdf, it) => {
    expect(() => assertKdfParams(kdf, it)).toThrowError(expect.objectContaining({ code: 'weak_kdf' }));
  });
  it('deriveKeys refuses weak parameters unless explicitly allowed', async () => {
    await expectCode(deriveKeys('alice', PW, sid, 1000), 'weak_kdf');
  });
});

describe('deriveKeys', () => {
  it('matches the independent test vector', async () => {
    const { authKey, kek } = await deriveKeys('alice', PW, sid, 1000, fast);
    expect(hex(authKey)).toBe(VECTOR.authKey);

    // kek is non-extractable: check it against the vector by encrypting the
    // same plaintext with a fixed IV under both keys.
    const ref = await crypto.subtle.importKey('raw', bytes(Buffer.from(VECTOR.kek, 'hex')), 'AES-GCM', false, ['encrypt']);
    const iv = new Uint8Array(12);
    const data = utf8('probe');
    const a = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, data);
    const b = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ref, data);
    expect(hex(new Uint8Array(a))).toBe(hex(new Uint8Array(b)));
    expect(kek.extractable).toBe(false);
  });

  it('depends on the SyncID, the password and the username', async () => {
    const base = hex((await deriveKeys('alice', PW, sid, 1000, fast)).authKey);
    const otherSid = sid.slice();
    otherSid[0] = 99;
    expect(hex((await deriveKeys('alice', PW, otherSid, 1000, fast)).authKey)).not.toBe(base);
    expect(hex((await deriveKeys('alice', PW + '!', sid, 1000, fast)).authKey)).not.toBe(base);
    expect(hex((await deriveKeys('bob', PW, sid, 1000, fast)).authKey)).not.toBe(base);
  });

  it('normalizes the password to NFC', async () => {
    const composed = 'café';
    const decomposed = 'café';
    const a = await deriveKeys('alice', composed, sid, 1000, fast);
    const b = await deriveKeys('alice', decomposed, sid, 1000, fast);
    expect(hex(a.authKey)).toBe(hex(b.authKey));
  });
});

describe('vault key wrapping', () => {
  const encryptWith = async (key: CryptoKey) => {
    const iv = new Uint8Array(12);
    return hex(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8('payload'))));
  };

  it('creates a non-extractable key that unwraps to the same key', async () => {
    const { kek } = await deriveKeys('alice', PW, sid, 1000, fast);
    const { key, wrapped } = await createVaultKey(kek, 'alice');
    expect(key.extractable).toBe(false);
    const again = await unwrapVaultKey(wrapped, kek, 'alice');
    expect(again.extractable).toBe(false);
    expect(await encryptWith(again)).toBe(await encryptWith(key));
  });

  it('re-wraps from stored bytes without needing an extractable key', async () => {
    const { kek: oldKek } = await deriveKeys('alice', PW, sid, 1000, fast);
    const { kek: newKek } = await deriveKeys('alice', 'a new password', sid, 1000, fast);
    const { key, wrapped } = await createVaultKey(oldKek, 'alice');

    const rewrapped = await rewrapVaultKey(wrapped, oldKek, newKek, 'alice');
    const unwrapped = await unwrapVaultKey(rewrapped, newKek, 'alice');
    expect(await encryptWith(unwrapped)).toBe(await encryptWith(key));
    await expectCode(unwrapVaultKey(rewrapped, oldKek, 'alice'), 'auth_failed');
  });

  it('fails with the wrong kek, the wrong username or truncated bytes', async () => {
    const { kek } = await deriveKeys('alice', PW, sid, 1000, fast);
    const { kek: other } = await deriveKeys('alice', 'wrong', sid, 1000, fast);
    const { wrapped } = await createVaultKey(kek, 'alice');
    await expectCode(unwrapVaultKey(wrapped, other, 'alice'), 'auth_failed');
    await expectCode(unwrapVaultKey(wrapped, kek, 'mallory'), 'auth_failed');
    await expectCode(unwrapVaultKey(wrapped.subarray(0, 10), kek, 'alice'), 'auth_failed');
  });

  it('uses a fresh IV for every wrap', async () => {
    const { kek } = await deriveKeys('alice', PW, sid, 1000, fast);
    const { wrapped } = await createVaultKey(kek, 'alice');
    const a = await rewrapVaultKey(wrapped, kek, kek, 'alice');
    const b = await rewrapVaultKey(wrapped, kek, kek, 'alice');
    expect(hex(a)).not.toBe(hex(b));
  });
});
