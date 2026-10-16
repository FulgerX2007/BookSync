// Go → TS interop: envelopes and wrapped vault keys written by the Go client
// core (internal/client/crypto, `go test -run TestWriteGoFixtures -update`)
// must decrypt here, so every extension can read what an Android device uploads.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveKeys, unwrapVaultKey } from '../../src/crypto/keys';
import { decryptVault } from '../../src/crypto/vault-cipher';
import type { VaultDoc } from '../../src/model/vault';

const DIR = fileURLToPath(new URL('../../../testdata/conformance/', import.meta.url));
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));

interface Fixture<I, E> {
  cases: { name: string; input: I; expected: E }[];
}

function load<I, E>(file: string): Fixture<I, E> {
  return JSON.parse(readFileSync(DIR + file, 'utf8')) as Fixture<I, E>;
}

// TODO(android plan Task 3): the Go side writes these files; until then the tests are skipped.
const haveGo = existsSync(DIR + 'envelope-go.json') && existsSync(DIR + 'wrap-go.json');

describe.skipIf(!haveGo)('Go-written fixtures', () => {
  it('decrypts every Go envelope to a document equal to the one Go encoded', async () => {
    const { cases } = load<{ username: string; vaultKey: string; envelope: string }, { doc: VaultDoc }>('envelope-go.json');
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const key = await crypto.subtle.importKey('raw', unhex(c.input.vaultKey), { name: 'AES-GCM' }, false, ['decrypt']);
      const doc = await decryptVault(Uint8Array.from(Buffer.from(c.input.envelope, 'base64')), key, c.input.username);
      expect(doc, c.name).toEqual(c.expected.doc);
    }
  });

  it('unwraps every Go-wrapped vault key to the original key', async () => {
    type Input = { username: string; password: string; syncId: string; iterations: number; vaultKey: string; wrappedVaultKey: string };
    const { cases } = load<Input, unknown>('wrap-go.json');
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const { kek } = await deriveKeys(c.input.username, c.input.password, unhex(c.input.syncId), c.input.iterations, { allowWeak: true });
      const unwrapped = await unwrapVaultKey(unhex(c.input.wrappedVaultKey), kek, c.input.username);
      // The unwrapped key is non-extractable: prove it equals the original by a round trip.
      const original = await crypto.subtle.importKey('raw', unhex(c.input.vaultKey), { name: 'AES-GCM' }, false, ['decrypt']);
      const iv = new Uint8Array(12);
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, unwrapped, new TextEncoder().encode(c.name));
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, original, ct);
      expect(new TextDecoder().decode(pt)).toBe(c.name);
    }
  });
});
