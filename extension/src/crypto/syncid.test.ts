import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CryptoError } from './errors';
import { formatSyncId, generateSyncId, parseSyncId } from './syncid';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const arbId = fc.uint8Array({ minLength: 16, maxLength: 16 });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof CryptoError ? e.code : 'other';
  }
  return undefined;
}

describe('SyncID', () => {
  it('formats as BS1 plus seven groups of four', () => {
    expect(formatSyncId(generateSyncId())).toMatch(/^BS1(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
  });

  it('round-trips any 16 bytes', () => {
    fc.assert(
      fc.property(arbId, (id) => {
        expect(parseSyncId(formatSyncId(id))).toEqual(id);
      }),
    );
  });

  it('tolerates case, spacing, missing prefix and I/L/O confusion', () => {
    const id = Uint8Array.from({ length: 16 }, (_, i) => i * 17);
    const formatted = formatSyncId(id);
    const variants = [
      formatted.toLowerCase(),
      formatted.replaceAll('-', ' '),
      formatted.replaceAll('-', ''),
      formatted.slice(4),
      formatted.replaceAll('1', 'l').replaceAll('0', 'O'),
      `  ${formatted.replaceAll('1', 'I')}  `,
    ];
    for (const v of variants) expect(parseSyncId(v), v).toEqual(id);
  });

  it('detects every single-character substitution', () => {
    fc.assert(
      fc.property(arbId, fc.nat(27), fc.nat(31), (id, pos, sym) => {
        const body = formatSyncId(id).slice(4).replaceAll('-', '');
        const replacement = ALPHABET[sym]!;
        fc.pre(body[pos] !== replacement);
        const typo = body.slice(0, pos) + replacement + body.slice(pos + 1);
        expect(codeOf(() => parseSyncId(typo))).toBe('invalid_checksum');
      }),
    );
  });

  it('detects swapped adjacent characters', () => {
    fc.assert(
      fc.property(arbId, fc.nat(26), (id, pos) => {
        const body = formatSyncId(id).slice(4).replaceAll('-', '');
        fc.pre(body[pos] !== body[pos + 1]);
        const swapped = body.slice(0, pos) + body[pos + 1] + body[pos] + body.slice(pos + 2);
        expect(codeOf(() => parseSyncId(swapped))).toBe('invalid_checksum');
      }),
    );
  });

  it.each([
    ['too short', 'BS1-AAAA'],
    ['too long', formatSyncId(new Uint8Array(16)) + 'A'],
    ['invalid character', formatSyncId(new Uint8Array(16)).slice(0, -1) + 'U'],
    ['empty', ''],
  ])('rejects %s as invalid_format', (_name, input) => {
    expect(codeOf(() => parseSyncId(input))).toBe('invalid_format');
  });

  it('rejects a value above 128 bits', () => {
    expect(codeOf(() => parseSyncId('Z'.repeat(28)))).toBe('invalid_checksum');
  });
});
