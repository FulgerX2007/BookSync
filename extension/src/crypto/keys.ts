// Key derivation and vault-key wrapping (see "Cryptography" in the plan).
//
//   stretched = PBKDF2-SHA256(password, SHA-256("booksync/v1|" + username), iterations)
//   authKey   = HKDF-SHA256(stretched, salt = SyncID, "booksync/v1/auth")  → server
//   kek       = HKDF-SHA256(stretched, salt = SyncID, "booksync/v1/kek")   → stays here
//
// The vault key is random. It is stored on the server wrapped under kek, and
// held locally as a non-extractable CryptoKey.
import { CryptoError, bytes, concat, utf8 } from './errors';

export const KDF_NAME = 'pbkdf2-sha256';
export const MIN_ITERATIONS = 600_000;
export const MAX_ITERATIONS = 10_000_000;
export const AUTH_KEY_BYTES = 32;
const IV_BYTES = 12;
const USERNAME_RE = /^[a-z0-9._-]{3,64}$/;

/** Same rule as the server: trimmed and lowercased. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

/** Refuses KDF parameters weaker than ours, whatever the server says. */
export function assertKdfParams(kdf: string, iterations: number): void {
  if (kdf !== KDF_NAME || !Number.isSafeInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new CryptoError('weak_kdf', `refusing key derivation parameters ${kdf}/${iterations}`);
  }
}

export interface DerivedKeys {
  /** Sent to the server as proof of password + SyncID. */
  authKey: Uint8Array<ArrayBuffer>;
  /** Wraps the vault key; never leaves the device. */
  kek: CryptoKey;
}

export interface DeriveOptions {
  /** Tests only: allow a low iteration count for speed. */
  allowWeak?: boolean;
}

export async function deriveKeys(
  username: string,
  password: string,
  syncId: Uint8Array,
  iterations: number,
  opts: DeriveOptions = {},
): Promise<DerivedKeys> {
  if (!opts.allowWeak) assertKdfParams(KDF_NAME, iterations);
  const subtle = crypto.subtle;
  const salt = await subtle.digest('SHA-256', utf8('booksync/v1|' + username));
  const pw = await subtle.importKey('raw', utf8(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const stretched = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, pw, 256);

  const ikm = await subtle.importKey('raw', stretched, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: bytes(syncId), info: utf8(info) });
  const authKey = new Uint8Array(await subtle.deriveBits(hkdf('booksync/v1/auth'), ikm, AUTH_KEY_BYTES * 8));
  const kek = await subtle.deriveKey(hkdf('booksync/v1/kek'), ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { authKey, kek };
}

const wrapAad = (username: string) => utf8('booksync/v1/wrap|' + username);

async function wrapRaw(raw: Uint8Array<ArrayBuffer>, kek: CryptoKey, username: string): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: wrapAad(username) }, kek, raw);
  return concat(iv, new Uint8Array(ct));
}

async function unwrapRaw(wrapped: Uint8Array, kek: CryptoKey, username: string): Promise<Uint8Array<ArrayBuffer>> {
  if (wrapped.length < IV_BYTES + 16) throw new CryptoError('auth_failed', 'wrapped vault key is truncated');
  try {
    const raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(wrapped.subarray(0, IV_BYTES)), additionalData: wrapAad(username) },
      kek,
      bytes(wrapped.subarray(IV_BYTES)),
    );
    return new Uint8Array(raw);
  } catch {
    throw new CryptoError('auth_failed', 'could not unwrap the vault key (wrong password or SyncID)');
  }
}

function importVaultKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Creates a new random vault key; returns it non-extractable plus its wrapped bytes. */
export async function createVaultKey(kek: CryptoKey, username: string): Promise<{ key: CryptoKey; wrapped: Uint8Array<ArrayBuffer> }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  try {
    return { key: await importVaultKey(raw), wrapped: await wrapRaw(raw, kek, username) };
  } finally {
    raw.fill(0);
  }
}

export async function unwrapVaultKey(wrapped: Uint8Array, kek: CryptoKey, username: string): Promise<CryptoKey> {
  const raw = await unwrapRaw(wrapped, kek, username);
  try {
    return await importVaultKey(raw);
  } finally {
    raw.fill(0);
  }
}

/** Re-wraps the vault key under a new kek (password change), without ever exposing it as a CryptoKey. */
export async function rewrapVaultKey(wrapped: Uint8Array, oldKek: CryptoKey, newKek: CryptoKey, username: string): Promise<Uint8Array<ArrayBuffer>> {
  const raw = await unwrapRaw(wrapped, oldKek, username);
  try {
    return await wrapRaw(raw, newKek, username);
  } finally {
    raw.fill(0);
  }
}
