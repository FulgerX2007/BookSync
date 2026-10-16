// Golden conformance corpus for other BookSync clients (the Go core in
// internal/client). The TS code is the reference: every expected value below
// is computed by it. Other clients replay testdata/conformance/*.json.
//
//   npm run conformance:gen                               rewrites the corpus
//   CONFORMANCE_ENVELOPES=1 npm run conformance:gen       also rewrites envelope.json
//
// Without CONFORMANCE_WRITE the test regenerates in memory and fails if the
// committed files are stale, so `npm run check` catches drift. envelope.json
// is excluded from that comparison: its bytes depend on the zlib behind
// CompressionStream. It is only checked to decrypt to its own document.
import fc from 'fast-check';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVaultKey, deriveKeys } from '../../src/crypto/keys';
import { formatSyncId, parseSyncId } from '../../src/crypto/syncid';
import { CryptoError } from '../../src/crypto/errors';
import { decryptVault, encryptVault } from '../../src/crypto/vault-cipher';
import {
  ROOT_MENU,
  ROOT_MOBILE,
  ROOT_OTHER,
  ROOT_TOOLBAR,
  VaultDocError,
  parseVaultDoc,
  treesEqual,
  validateTree,
  type VaultDoc,
} from '../../src/model/vault';
import type { PendingConfirmation } from '../../src/storage/state';
import { confirmationCovers, guardCheck } from '../../src/sync/guard';
import { diffStats, merge3 } from '../../src/sync/merge';
import { arbEdits, arbTree, applyEdits } from '../arbitraries';
import { doc, type Spec } from '../builders';

const DIR = fileURLToPath(new URL('../../../testdata/conformance/', import.meta.url));
const WRITE = process.env.CONFORMANCE_WRITE === '1';
const WRITE_ENVELOPES = process.env.CONFORMANCE_ENVELOPES === '1';

interface Case {
  name: string;
  input: unknown;
  expected: unknown;
}

// One case per line keeps diffs reviewable and the files small.
function render(generator: string, seed: number, cases: Case[]): string {
  return `{"generator":${JSON.stringify(generator)},"seed":${seed},"cases":[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`;
}

function emit(file: string, generator: string, seed: number, cases: Case[]): void {
  const text = render(generator, seed, cases);
  const path = DIR + file;
  if (WRITE) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path, text);
    return;
  }
  expect(existsSync(path), `${file} is missing; run npm run conformance:gen`).toBe(true);
  expect(readFileSync(path, 'utf8') === text, `${file} is stale; run npm run conformance:gen`).toBe(true);
}

// --- deterministic randomness -------------------------------------------------

/** mulberry32: a small seeded PRNG, enough to fix IVs, keys and SyncIDs. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every byte crypto.getRandomValues hands out, in order. */
let handedOut: Uint8Array[] = [];

function seedRandom(seed: number): void {
  const next = prng(seed);
  handedOut = [];
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
    const view = new Uint8Array(array!.buffer, array!.byteOffset, array!.byteLength);
    for (let i = 0; i < view.length; i++) view[i] = Math.floor(next() * 256);
    handedOut.push(view.slice());
    return array;
  });
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

function errorCode(e: unknown): string {
  if (e instanceof CryptoError || e instanceof VaultDocError) return e.code;
  throw e;
}

// --- shared trees ---------------------------------------------------------------

const T = ROOT_TOOLBAR;
const O = ROOT_OTHER;
const tree = (toolbar: Spec[], other: Spec[] = []) => doc({ [T]: toolbar, [O]: other });

/** A remote side looks like an uploaded vault: non-zero header fields. */
function asRemote(d: VaultDoc, seq = 7): VaultDoc {
  return { ...d, seq, writtenBy: 'device-r', writtenAt: 1_760_000_000_000 };
}

/** Edge-case documents every client must encode and decode identically. */
function edgeDocs(): Record<string, VaultDoc> {
  const d = tree(
    [
      { f: 'emptyFolder' },
      { b: 'emptyUrl', url: '' },
      { b: 'emptyTitle', title: '' },
      { b: 'unicode', title: 'Café ☕ 日本語 \u{1F600}', url: 'https://例え.テスト/パス?q=ü#frag' },
      { b: 'escapes', title: '<b>"quoted" & \'single\'</b>\\\n\t', url: 'https://x.example/?a=1&b=<2>' },
      { b: 'jsUrl', url: 'javascript:alert(1)' },
    ],
    [{ f: 'nested', children: [{ f: 'deeper', children: [{ b: 'leaf' }] }] }],
  );
  d.nodes[ROOT_MENU]!.title = 'Lesezeichen-Menü';
  return { empty: doc({}), edges: { ...asRemote(d, 42), writtenAt: 1_760_000_000_000.5 } };
}

// --- generators ---------------------------------------------------------------

async function keysCases(): Promise<Case[]> {
  const sid = Uint8Array.from({ length: 16 }, (_, i) => i);
  const inputs: { name: string; username: string; password: string; syncId: Uint8Array; iterations: number }[] = [
    { name: 'protocol §1.2 vector', username: 'alice', password: 'correct horse battery staple', syncId: sid, iterations: 1000 },
    { name: 'non-ASCII NFC password', username: 'bob.smith', password: 'pässwörd ☃ 密码', syncId: sid, iterations: 1000 },
    { name: 'empty password', username: 'carol_99', password: '', syncId: new Uint8Array(16).fill(0xff), iterations: 1000 },
    { name: 'other iteration count', username: 'dave-x', password: 'hunter2', syncId: sid.map((b) => b * 7), iterations: 1234 },
  ];
  const cases: Case[] = [];
  for (const [i, c] of inputs.entries()) {
    seedRandom(1000 + i);
    const { authKey, kek } = await deriveKeys(c.username, c.password, c.syncId, c.iterations, { allowWeak: true });
    handedOut = [];
    const { wrapped } = await createVaultKey(kek, c.username);
    const [vaultKey, iv] = handedOut;
    expect(vaultKey).toHaveLength(32);
    expect(iv).toHaveLength(12);
    cases.push({
      name: c.name,
      input: { username: c.username, password: c.password, syncId: hex(c.syncId), iterations: c.iterations },
      expected: { authKey: hex(authKey), vaultKey: hex(vaultKey!), wrappedVaultKey: hex(wrapped) },
    });
  }
  // TS normalizes to NFC before PBKDF2. Other clients may receive the password
  // already normalized (the Android app does this in Kotlin); passwordNFC says
  // what the derivation actually used.
  const nfd = 'pässwörd';
  seedRandom(2000);
  const { authKey } = await deriveKeys('erin', nfd, sid, 1000, { allowWeak: true });
  cases.push({
    name: 'decomposed (NFD) password is normalized to NFC',
    input: { username: 'erin', password: nfd, passwordNFC: nfd.normalize('NFC'), syncId: hex(sid), iterations: 1000 },
    expected: { authKey: hex(authKey) },
  });
  return cases;
}

function syncIdCases(): Case[] {
  seedRandom(3000);
  const cases: Case[] = [];
  const ids = [new Uint8Array(16), new Uint8Array(16).fill(0xff), ...Array.from({ length: 10 }, () => crypto.getRandomValues(new Uint8Array(16)))];
  for (const id of ids) cases.push({ name: 'format', input: { op: 'format', bytes: hex(id) }, expected: { text: formatSyncId(id) } });

  const parse = (name: string, text: string) => {
    let expected: unknown;
    try {
      expected = { bytes: hex(parseSyncId(text)) };
    } catch (e) {
      expected = { error: errorCode(e) };
    }
    cases.push({ name, input: { op: 'parse', text }, expected });
  };
  const good = formatSyncId(ids[2]!);
  const body = good.slice(4).replaceAll('-', '');
  const swapAt = [...body].findIndex((c, i) => i < body.length - 1 && c !== body[i + 1]);
  const swapped = body.slice(0, swapAt) + body[swapAt + 1] + body[swapAt] + body.slice(swapAt + 2);
  const sub = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  parse('canonical', good);
  parse('lowercase', good.toLowerCase());
  parse('no prefix, no dashes', body);
  parse('spaces instead of dashes', good.replaceAll('-', ' '));
  parse('I, L and O read as 1 and 0', 'BS1' + body.replaceAll('1', 'l').replaceAll('0', 'O'));
  parse('substituted character', 'BS1' + sub(body, 5));
  parse('substituted check character', 'BS1' + sub(body, body.length - 1));
  parse('adjacent swap', 'BS1' + swapped);
  parse('too short', good.slice(0, -1));
  parse('too long', good + '0');
  parse('invalid character U', 'BS1' + 'U' + body.slice(1));
  parse('more than 128 bits', 'BS1' + 'Z' + body.slice(1));
  parse('empty', '');
  return cases;
}

function validateCases(): Case[] {
  const ok = doc({ [T]: [{ b: 'a' }, { f: 'f', children: [{ b: 'c' }] }] });
  const json = (d: unknown) => JSON.stringify(d);
  const mutate = (f: (d: VaultDoc & Record<string, unknown>) => void) => {
    const d = structuredClone(ok) as VaultDoc & Record<string, unknown>;
    f(d);
    return json(d);
  };
  const inputs: [string, string][] = [
    ['valid', json(ok)],
    ['empty roots only', json(doc({}))],
    ['fractional writtenAt', mutate((d) => (d.writtenAt = 1.5))],
    ['unknown header field is ignored', mutate((d) => (d.extra = true))],
    ['unknown node field is ignored', mutate((d) => Object.assign(d.nodes.a!, { favicon: 'x' }))],
    ['empty url', mutate((d) => (d.nodes.a!.url = ''))],
    ['format 2 is unsupported', mutate((d) => Object.assign(d, { format: 2 }))],
    ['format 0', mutate((d) => Object.assign(d, { format: 0 }))],
    ['format missing', mutate((d) => delete (d as Partial<VaultDoc>).format)],
    ['format as string', mutate((d) => Object.assign(d, { format: '1' }))],
    ['fractional seq', mutate((d) => (d.seq = 1.5))],
    ['negative seq', mutate((d) => (d.seq = -1))],
    ['writtenBy missing', mutate((d) => delete (d as Partial<VaultDoc>).writtenBy)],
    ['writtenAt as string', mutate((d) => Object.assign(d, { writtenAt: '0' }))],
    ['nodes is an array', mutate((d) => Object.assign(d, { nodes: [] }))],
    ['not JSON', '{"format":1,'],
    ['top-level array', '[]'],
    ['JSON null', 'null'],
    ['missing root', mutate((d) => delete d.nodes[ROOT_MOBILE])],
    ['guid mismatch', mutate((d) => (d.nodes.a!.guid = 'zzz'))],
    ['bookmark without url', mutate((d) => delete d.nodes.a!.url)],
    ['bookmark with url null', mutate((d) => Object.assign(d.nodes.a!, { url: null }))],
    ['bookmark with children', mutate((d) => (d.nodes.a!.children = []))],
    ['folder with url', mutate((d) => (d.nodes.f!.url = 'https://f/'))],
    ['folder without children', mutate((d) => delete d.nodes.f!.children)],
    ['folder with children null', mutate((d) => Object.assign(d.nodes.f!, { children: null }))],
    ['folder with non-string child', mutate((d) => Object.assign(d.nodes.f!, { children: [1] }))],
    ['unknown kind', mutate((d) => Object.assign(d.nodes.a!, { kind: 'separator' }))],
    ['title missing', mutate((d) => delete (d.nodes.a as Partial<VaultDoc['nodes'][string]>).title)],
    ['dangling child', mutate((d) => d.nodes.f!.children!.push('ghost'))],
    ['multiple parents', mutate((d) => d.nodes[O]!.children!.push('c'))],
    ['root as child', mutate((d) => d.nodes.f!.children!.push(ROOT_MOBILE))],
    [
      'cycle',
      mutate((d) => {
        d.nodes[T]!.children = ['a'];
        d.nodes.f!.children = ['c', 'g'];
        d.nodes.g = { guid: 'g', kind: 'folder', title: 'g', children: ['f'] };
      }),
    ],
    ['unreachable', mutate((d) => (d.nodes.lost = { guid: 'lost', kind: 'bookmark', title: 'lost', url: 'https://lost/' }))],
    ['root as bookmark', mutate((d) => (d.nodes[ROOT_MENU] = { guid: ROOT_MENU, kind: 'bookmark', title: 'm', url: 'https://m/' }))],
    ['numeric-looking guids', json(doc({ [T]: [{ b: '10' }, { b: '2' }, { f: '1', children: [{ b: '0' }] }] }))],
  ];
  return inputs.map(([name, text]) => {
    let expected: unknown;
    try {
      parseVaultDoc(new TextEncoder().encode(text));
      expected = { ok: true, violations: [] };
    } catch (e) {
      const code = errorCode(e);
      // Tree-level failures also list every violation (sorted), so other
      // clients can check their validator, not just the verdict.
      const tree = e instanceof Error && e.message.startsWith('vault tree is invalid');
      const violations = tree ? validateTree(JSON.parse(text) as VaultDoc).map((v) => `${v.kind}:${v.guid}`).sort() : null;
      expected = { ok: false, error: code, violations };
    }
    return { name, input: { json: text }, expected };
  });
}

function equalCases(): Case[] {
  const a = tree([{ b: 'a' }, { f: 'f', children: [{ b: 'c' }] }]);
  const variants: [string, (d: VaultDoc) => void][] = [
    ['identical', () => {}],
    ['header differs', (d) => Object.assign(d, { seq: 9, writtenBy: 'x', writtenAt: 5 })],
    ['root title differs (localized)', (d) => (d.nodes[T]!.title = 'Lesezeichenleiste')],
    ['title differs', (d) => (d.nodes.a!.title = 'A')],
    ['url differs', (d) => (d.nodes.a!.url = 'https://other/')],
    ['empty url vs url', (d) => (d.nodes.a!.url = '')],
    ['child order differs', (d) => d.nodes[T]!.children!.reverse()],
    ['moved', (d) => (d.nodes[T]!.children = ['f'], d.nodes.f!.children!.push('a'))],
    ['node added', (d) => (d.nodes.n = { guid: 'n', kind: 'bookmark', title: 'n', url: 'https://n/' }, d.nodes[O]!.children!.push('n'))],
    ['node deleted', (d) => (d.nodes.f!.children = [], delete d.nodes.c)],
    ['kind differs', (d) => (d.nodes.c = { guid: 'c', kind: 'folder', title: 'c', children: [] })],
  ];
  return variants.map(([name, f]) => {
    const b = structuredClone(a);
    f(b);
    return { name, input: { a, b }, expected: { equal: treesEqual(a, b), diff: diffStats(a, b) } };
  });
}

function mergeCase(name: string, base: VaultDoc, local: VaultDoc, remote: VaultDoc): Case {
  const { doc: merged, stats } = merge3(base, local, remote);
  expect(validateTree(merged)).toEqual([]);
  return { name, input: { base, local, remote }, expected: { merged, stats } };
}

const MERGE_SEED = 20261016;
const MERGE_RANDOM = 150;

function merge3Cases(): Case[] {
  const c: Case[] = [];
  const m = (name: string, base: VaultDoc, local: VaultDoc, remote: VaultDoc) => c.push(mergeCase(name, base, local, asRemote(remote)));

  // One per row of the merge table (docs/protocol.md §4.4), mirroring merge.test.ts.
  m('unchanged', tree([{ b: 'a' }]), tree([{ b: 'a' }]), tree([{ b: 'a' }]));
  m('adds on both sides', tree([{ b: 'a' }]), tree([{ b: 'a' }, { b: 'x' }]), tree([{ b: 'a' }, { b: 'y' }]));
  m('one-sided changes', tree([{ b: 'a' }, { b: 'c' }]), tree([{ b: 'a', title: 'L' }, { b: 'c' }]), tree([{ b: 'a' }, { b: 'c', url: 'https://new/' }]));
  m('identical change', tree([{ b: 'a' }]), tree([{ b: 'a', title: 'same' }]), tree([{ b: 'a', title: 'same' }]));
  m('title and url conflict', tree([{ b: 'a' }]), tree([{ b: 'a', title: 'L', url: 'https://l/' }]), tree([{ b: 'a', title: 'R', url: 'https://r/' }]));
  m('local edit beats remote delete', tree([{ b: 'a' }, { b: 'b' }]), tree([{ b: 'a', title: 'edited' }, { b: 'b' }]), tree([{ b: 'b' }]));
  m('remote edit beats local delete', tree([{ b: 'a' }, { b: 'b' }]), tree([{ b: 'b' }]), tree([{ b: 'a', url: 'https://edited/' }, { b: 'b' }]));
  m('one-sided delete', tree([{ b: 'a' }, { b: 'b' }]), tree([{ b: 'b' }]), tree([{ b: 'a' }, { b: 'b' }]));
  m('deleted on both sides', tree([{ b: 'a' }, { b: 'b' }]), tree([{ b: 'b' }]), tree([{ b: 'b' }]));
  m('reorder is not an edit', tree([{ f: 'f', children: [{ b: 'x' }, { b: 'y' }] }]), tree([]), tree([{ f: 'f', children: [{ b: 'y' }, { b: 'x' }] }]));
  m('Dogear: child added to deleted folder', tree([{ b: 'a' }, { f: 'f', children: [{ b: 'x' }] }]), tree([{ b: 'a' }, { f: 'f', children: [{ b: 'x' }, { b: 'c' }] }]), tree([{ b: 'a' }]));
  m('Dogear: edited child of deleted folder', tree([{ f: 'f', children: [{ b: 'x' }, { b: 'y' }] }]), tree([{ f: 'f', children: [{ b: 'x', title: 'kept' }, { b: 'y' }] }]), tree([]));
  m(
    'Dogear: several levels',
    tree([{ f: 'f', children: [{ f: 'g', children: [{ b: 'x' }] }] }]),
    tree([{ f: 'f', children: [{ f: 'g', children: [{ b: 'x' }, { b: 'new' }] }] }]),
    tree([]),
  );
  m('moved into deleted folder', tree([{ b: 'a' }, { f: 'f' }]), tree([{ f: 'f', children: [{ b: 'a' }] }]), tree([{ b: 'a' }]));
  m('edited folder survives delete, emptied', tree([{ f: 'f', children: [{ b: 'x' }] }]), tree([]), tree([{ f: 'f', title: 'renamed', children: [{ b: 'x' }] }]));
  m(
    'move/move conflict',
    tree([{ b: 'a' }, { f: 'f' }, { f: 'g' }]),
    tree([{ f: 'f', children: [{ b: 'a' }] }, { f: 'g' }]),
    tree([{ f: 'f' }, { f: 'g', children: [{ b: 'a' }] }]),
  );
  m('cycle from crossing moves', tree([{ f: 'f' }, { f: 'g' }]), tree([{ f: 'g', children: [{ f: 'f' }] }]), tree([{ f: 'f', children: [{ f: 'g' }] }]));
  m(
    'one-sided reorder plus other side add',
    tree([{ b: 'a' }, { b: 'b' }, { b: 'c' }]),
    tree([{ b: 'c' }, { b: 'a' }, { b: 'b' }]),
    tree([{ b: 'a' }, { b: 'b' }, { b: 'd' }, { b: 'c' }]),
  );
  m('both reordered', tree([{ b: 'a' }, { b: 'b' }, { b: 'c' }]), tree([{ b: 'c' }, { b: 'b' }, { b: 'a' }]), tree([{ b: 'b' }, { b: 'a' }, { b: 'c' }]));
  m('local add at front', tree([{ b: 'a' }, { b: 'b' }]), tree([{ b: 'x' }, { b: 'a' }, { b: 'b' }]), tree([{ b: 'a' }, { b: 'b' }]));
  m('same guid added with different values', tree([]), tree([{ b: 'n', title: 'L' }]), tree([{ b: 'n', title: 'R' }]));
  m('same guid, different kinds', tree([]), tree([{ b: 'n' }]), tree([{ f: 'n' }]));
  m(
    'change counts in both directions',
    tree([{ b: 'a' }, { b: 'b' }, { f: 'f' }]),
    tree([{ b: 'a', title: 'A' }, { b: 'b' }, { f: 'f' }, { b: 'l' }]),
    tree([{ f: 'f', children: [{ b: 'b' }] }, { b: 'r' }]),
  );
  {
    const base = tree([{ b: 'a' }]);
    const local = structuredClone(base);
    local.nodes[T]!.title = 'Lesezeichenleiste';
    const remote = structuredClone(base);
    remote.nodes[O]!.title = 'Autres marque-pages';
    m('roots keep canonical titles', base, local, remote);
  }
  m('empty base, empty sides', doc({}), doc({}), doc({}));
  m('orphans appended in guid order', tree([{ f: 'f', children: [{ b: 'z' }, { b: 'y' }] }], [{ b: 'q' }]), tree([{ f: 'f', children: [{ b: 'z', title: 'Z' }, { b: 'y', title: 'Y' }] }], [{ b: 'q' }]), tree([], [{ b: 'q' }]));

  // Seeded random cases: the same generators as the property tests.
  const samples = fc.sample(fc.tuple(arbTree, arbEdits(), arbEdits(), fc.boolean()), { seed: MERGE_SEED, numRuns: MERGE_RANDOM });
  samples.forEach(([base, le, re, localized], i) => {
    const local = applyEdits(base, le, 'l');
    const remote = applyEdits(base, re, 'r');
    if (localized) local.nodes[T]!.title = 'Barre personnelle';
    c.push(mergeCase(`random #${i}`, base, local, asRemote(remote, i + 1)));
  });
  return c;
}

function bookmarks(prefix: string, n: number): Spec[] {
  return Array.from({ length: n }, (_, i) => ({ b: `${prefix}${i}` }));
}

function guardCases(): Case[] {
  const cases: Case[] = [];
  // deletions toward local: local has `total` bookmarks, remote/merged drop `deleted` of them.
  const towardLocal = (name: string, total: number, deleted: number, remoteVersion: number | null = 3) => {
    const local = tree(bookmarks('x', total));
    const merged = tree(bookmarks('x', total).slice(deleted));
    cases.push({ name, input: { op: 'check', local, remote: merged, merged, remoteVersion }, expected: { pending: guardCheck(local, merged, merged, remoteVersion) } });
  };
  const towardRemote = (name: string, total: number, deleted: number) => {
    const remote = tree(bookmarks('x', total));
    const merged = tree(bookmarks('x', total).slice(deleted));
    cases.push({ name, input: { op: 'check', local: merged, remote, merged, remoteVersion: 8 }, expected: { pending: guardCheck(merged, remote, merged, 8) } });
  };
  towardLocal('19 of 19 deleted: below the minimum', 19, 19);
  towardLocal('20 of 20 deleted', 20, 20);
  towardLocal('20 of 80 deleted: exactly 25 %', 80, 20);
  towardLocal('20 of 79 deleted: above 25 %', 79, 20);
  towardLocal('40 of 100 deleted', 100, 40);
  towardLocal('no remote version yet', 30, 30, null);
  towardRemote('20 of 20 deleted toward the server', 20, 20);
  towardRemote('20 of 81 toward the server', 81, 20);
  towardLocal('nothing deleted', 50, 0);

  const p: PendingConfirmation = { remoteVersion: 3, deletionsToLocal: 20, deletionsToRemote: 0 };
  const covers: [string, PendingConfirmation | undefined, PendingConfirmation][] = [
    ['same', p, p],
    ['no confirmation', undefined, p],
    ['fewer deletions', p, { ...p, deletionsToLocal: 19 }],
    ['more deletions toward local', p, { ...p, deletionsToLocal: 21 }],
    ['more deletions toward remote', p, { ...p, deletionsToRemote: 1 }],
    ['other version', p, { ...p, remoteVersion: 4 }],
    ['null versions', { ...p, remoteVersion: null }, { ...p, remoteVersion: null }],
  ];
  for (const [name, confirmed, pending] of covers) {
    cases.push({ name: `covers: ${name}`, input: { op: 'covers', confirmed: confirmed ?? null, pending }, expected: { covers: confirmationCovers(confirmed, pending) } });
  }
  return cases;
}

async function envelopeCases(): Promise<Case[]> {
  const cases: Case[] = [];
  for (const [i, [name, d]] of Object.entries(edgeDocs()).entries()) {
    seedRandom(4000 + i);
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const envelope = await encryptVault(d, key, 'alice');
    cases.push({ name, input: { username: 'alice', vaultKey: hex(raw), envelope: b64(envelope) }, expected: { doc: d } });
  }
  return cases;
}

// --- tests --------------------------------------------------------------------

describe('conformance corpus', () => {
  beforeEach(() => {
    handedOut = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keys.json', async () => emit('keys.json', 'deriveKeys + createVaultKey', 1000, await keysCases()));
  it('syncid.json', () => emit('syncid.json', 'formatSyncId / parseSyncId', 3000, syncIdCases()));
  it('validate.json', () => emit('validate.json', 'parseVaultDoc + validateTree', 0, validateCases()));
  it('equal.json', () => emit('equal.json', 'treesEqual + diffStats', 0, equalCases()));
  it('merge3.json', () => emit('merge3.json', 'merge3', MERGE_SEED, merge3Cases()));
  it('guard.json', () => emit('guard.json', 'guardCheck / confirmationCovers', 0, guardCases()));

  it('envelope.json', async () => {
    const path = DIR + 'envelope.json';
    if (WRITE_ENVELOPES || (WRITE && !existsSync(path))) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(path, render('encryptVault', 4000, await envelopeCases()));
    }
    // Whatever zlib produced, the committed envelopes must decrypt to their documents.
    const { cases } = JSON.parse(readFileSync(path, 'utf8')) as { cases: Case[] };
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const input = c.input as { username: string; vaultKey: string; envelope: string };
      const key = await crypto.subtle.importKey('raw', unhex(input.vaultKey), { name: 'AES-GCM' }, false, ['decrypt']);
      const got = await decryptVault(Uint8Array.from(Buffer.from(input.envelope, 'base64')), key, input.username);
      expect(got).toEqual((c.expected as { doc: VaultDoc }).doc);
    }
  });

  it('is deterministic', async () => {
    const once = render('m', MERGE_SEED, merge3Cases()) + render('k', 0, await keysCases());
    const twice = render('m', MERGE_SEED, merge3Cases()) + render('k', 0, await keysCases());
    expect(once === twice).toBe(true);
  });
});
