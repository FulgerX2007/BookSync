// Vault envelope: "BSV1" ‖ iv(12) ‖ AES-256-GCM(vaultKey, iv, aad, gzip(JSON(doc))).
// The AAD binds the ciphertext to its purpose and user, so a server cannot
// swap blobs between users.
import { parseVaultDoc, serializeVaultDoc, type VaultDoc } from '../model/vault';
import { CryptoError, bytes, concat, utf8 } from './errors';

const MAGIC = utf8('BSV1');
const IV_BYTES = 12;
const TAG_BYTES = 16;

const vaultAad = (username: string) => utf8('booksync/v1/vault|' + username);

async function pipe(data: Uint8Array<ArrayBuffer>, transform: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encryptVault(doc: VaultDoc, vaultKey: CryptoKey, username: string): Promise<Uint8Array<ArrayBuffer>> {
  const compressed = await pipe(bytes(serializeVaultDoc(doc)), new CompressionStream('gzip'));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: vaultAad(username) }, vaultKey, compressed);
  return concat(MAGIC, iv, new Uint8Array(ct));
}

export function hasVaultMagic(envelope: Uint8Array): boolean {
  return envelope.length >= MAGIC.length && MAGIC.every((b, i) => envelope[i] === b);
}

export async function decryptVault(envelope: Uint8Array, vaultKey: CryptoKey, username: string): Promise<VaultDoc> {
  if (!hasVaultMagic(envelope) || envelope.length < MAGIC.length + IV_BYTES + TAG_BYTES) {
    throw new CryptoError('bad_magic', 'not a BookSync vault');
  }
  const iv = bytes(envelope.subarray(MAGIC.length, MAGIC.length + IV_BYTES));
  let compressed: ArrayBuffer;
  try {
    compressed = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: vaultAad(username) },
      vaultKey,
      bytes(envelope.subarray(MAGIC.length + IV_BYTES)),
    );
  } catch {
    throw new CryptoError('auth_failed', 'vault could not be decrypted (wrong key, wrong user or tampered)');
  }
  // Authenticated plaintext from one of our own devices: decompression or
  // parse errors here mean a client bug, reported as bad_format by parseVaultDoc.
  let json: Uint8Array;
  try {
    json = await pipe(new Uint8Array(compressed), new DecompressionStream('gzip'));
  } catch {
    json = new Uint8Array();
  }
  return parseVaultDoc(json);
}
