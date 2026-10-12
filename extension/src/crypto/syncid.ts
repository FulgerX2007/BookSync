// The SyncID: 128 random bits generated at registration, never sent to the
// server and mixed into key derivation. Displayed as Crockford base32 with
// two check characters so typos are caught before a login round-trip:
//   BS1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
import { CryptoError } from './errors';

export const SYNC_ID_BYTES = 16;
const PREFIX = 'BS1';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U
const DATA_CHARS = 26; // ceil(128 / 5)
const CHECK_CHARS = 2;
// Prime modulus: a single substituted character or a swap of two adjacent
// characters always changes the value mod 1021, so it is always detected.
const CHECK_MODULUS = 1021n;

export function generateSyncId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SYNC_ID_BYTES));
}

function toBigInt(id: Uint8Array): bigint {
  let v = 0n;
  for (const b of id) v = (v << 8n) | BigInt(b);
  return v;
}

function encode(v: bigint, chars: number): string {
  let out = '';
  for (let i = 0; i < chars; i++) {
    out = ALPHABET[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return out;
}

export function formatSyncId(id: Uint8Array): string {
  if (id.length !== SYNC_ID_BYTES) throw new CryptoError('invalid_format', 'SyncID must be 16 bytes');
  const v = toBigInt(id);
  const body = encode(v, DATA_CHARS) + encode(v % CHECK_MODULUS, CHECK_CHARS);
  const groups = body.match(/.{1,4}/g) ?? [];
  return [PREFIX, ...groups].join('-');
}

/**
 * Parses a SyncID as typed by a person: case, spaces and dashes don't
 * matter, I/L read as 1 and O as 0, and the BS1 prefix is optional.
 */
export function parseSyncId(input: string): Uint8Array {
  let s = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  // Unambiguous: a valid body starts with 0-3 (128 bits in 130), never "B".
  if (s.startsWith(PREFIX)) s = s.slice(PREFIX.length);
  if (s.length !== DATA_CHARS + CHECK_CHARS) {
    throw new CryptoError('invalid_format', `SyncID must have ${DATA_CHARS + CHECK_CHARS} characters after the BS1 prefix`);
  }
  let v = 0n;
  const digits: bigint[] = [];
  for (const ch of s) {
    const d = ALPHABET.indexOf(ch);
    if (d < 0) throw new CryptoError('invalid_format', `SyncID contains an invalid character "${ch}"`);
    digits.push(BigInt(d));
  }
  for (const d of digits.slice(0, DATA_CHARS)) v = (v << 5n) | d;
  const check = digits.slice(DATA_CHARS).reduce((acc, d) => (acc << 5n) | d, 0n);
  if (v >> 128n !== 0n) {
    throw new CryptoError('invalid_checksum', 'SyncID has a typo');
  }
  if (v % CHECK_MODULUS !== check) {
    throw new CryptoError('invalid_checksum', 'SyncID has a typo');
  }
  const out = new Uint8Array(SYNC_ID_BYTES);
  for (let i = SYNC_ID_BYTES - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
