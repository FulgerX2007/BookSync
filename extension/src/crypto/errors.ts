export type CryptoErrorCode =
  | 'invalid_format' // SyncID is not well-formed
  | 'invalid_checksum' // SyncID has a typo
  | 'weak_kdf' // server offered KDF parameters below our minimum
  | 'bad_magic' // not a BookSync vault envelope
  | 'auth_failed'; // wrong key, wrong user, or tampered ciphertext

export class CryptoError extends Error {
  constructor(
    readonly code: CryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CryptoError';
  }
}

/** Copies into a fresh ArrayBuffer-backed array, as WebCrypto's BufferSource requires. */
export function bytes(src: ArrayLike<number> | ArrayBuffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(src instanceof ArrayBuffer ? src.slice(0) : Array.from(src));
}

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return bytes(new TextEncoder().encode(s));
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
