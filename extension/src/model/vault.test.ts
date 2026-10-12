import { describe, expect, it } from 'vitest';
import { doc } from '../../test/builders';
import {
  ROOT_GUIDS,
  ROOT_OTHER,
  ROOT_TOOLBAR,
  VaultDocError,
  countNodes,
  emptyDoc,
  isRoot,
  newGuid,
  parentsOf,
  parseVaultDoc,
  serializeVaultDoc,
  treesEqual,
  validateTree,
  type VaultDoc,
} from './vault';

const sample = () =>
  doc({
    [ROOT_TOOLBAR]: [{ b: 'a' }, { f: 'f', children: [{ b: 'b' }, { f: 'g', children: [{ b: 'c' }] }] }],
    [ROOT_OTHER]: [{ b: 'd' }],
  });

describe('emptyDoc / newGuid / helpers', () => {
  it('creates the four roots as empty folders', () => {
    const d = emptyDoc();
    expect(Object.keys(d.nodes).sort()).toEqual([...ROOT_GUIDS].sort());
    expect(validateTree(d)).toEqual([]);
    expect(countNodes(d)).toBe(0);
  });

  it('generates unique 12-char base64url guids that are never roots', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const g = newGuid();
      expect(g).toMatch(/^[A-Za-z0-9_-]{12}$/);
      expect(isRoot(g)).toBe(false);
      seen.add(g);
    }
    expect(seen.size).toBe(2000);
  });

  it('counts non-root nodes and maps parents', () => {
    const d = sample();
    expect(countNodes(d)).toBe(6);
    const p = parentsOf(d);
    expect(p.get('c')).toBe('g');
    expect(p.get('a')).toBe(ROOT_TOOLBAR);
    expect(p.has(ROOT_TOOLBAR)).toBe(false);
  });
});

describe('validateTree', () => {
  it('accepts a valid tree', () => {
    expect(validateTree(sample())).toEqual([]);
  });

  const cases: [string, (d: VaultDoc) => void, string][] = [
    ['missing root', (d) => delete d.nodes[ROOT_OTHER], 'missing_root'],
    ['guid mismatch', (d) => (d.nodes.a!.guid = 'zzz'), 'guid_mismatch'],
    ['bookmark without url', (d) => delete d.nodes.a!.url, 'bad_bookmark'],
    ['bookmark with children', (d) => (d.nodes.a!.children = []), 'bad_bookmark'],
    ['folder without children', (d) => delete d.nodes.f!.children, 'bad_folder'],
    ['folder with url', (d) => (d.nodes.f!.url = 'https://x/'), 'bad_folder'],
    ['dangling child', (d) => d.nodes.f!.children!.push('ghost'), 'dangling_child'],
    ['two parents', (d) => d.nodes[ROOT_OTHER]!.children!.push('a'), 'multiple_parents'],
    ['root as child', (d) => d.nodes.f!.children!.push(ROOT_OTHER), 'root_has_parent'],
    [
      'unreachable node',
      (d) => (d.nodes.orphan = { guid: 'orphan', kind: 'bookmark', title: 'o', url: 'https://o/' }),
      'unreachable',
    ],
    [
      'cycle',
      (d) => {
        // detach g from f and make g ⇄ h a cycle
        d.nodes.f!.children = ['b'];
        d.nodes.h = { guid: 'h', kind: 'folder', title: 'h', children: ['g'] };
        d.nodes.g!.children!.push('h');
      },
      'cycle',
    ],
  ];
  it.each(cases)('detects %s', (_name, mutate, kind) => {
    const d = sample();
    mutate(d);
    expect(validateTree(d).map((v) => v.kind)).toContain(kind);
  });
});

describe('treesEqual', () => {
  it('ignores metadata and root titles', () => {
    const a = sample();
    const b = sample();
    b.seq = 99;
    b.writtenBy = 'other';
    b.writtenAt = 123;
    b.nodes[ROOT_TOOLBAR]!.title = 'Lesezeichenleiste';
    expect(treesEqual(a, b)).toBe(true);
  });

  const changes: [string, (d: VaultDoc) => void][] = [
    ['title', (d) => (d.nodes.a!.title = 'renamed')],
    ['url', (d) => (d.nodes.a!.url = 'https://other/')],
    ['order', (d) => d.nodes[ROOT_TOOLBAR]!.children!.reverse()],
    [
      'parent',
      (d) => {
        d.nodes[ROOT_TOOLBAR]!.children = ['f'];
        d.nodes[ROOT_OTHER]!.children!.push('a');
      },
    ],
    ['added node', (d) => {
      d.nodes.x = { guid: 'x', kind: 'bookmark', title: 'x', url: 'https://x/' };
      d.nodes[ROOT_OTHER]!.children!.push('x');
    }],
  ];
  it.each(changes)('detects a %s change', (_name, mutate) => {
    const b = sample();
    mutate(b);
    expect(treesEqual(sample(), b)).toBe(false);
  });
});

describe('serialize / parse', () => {
  it('round-trips', () => {
    const d = sample();
    d.seq = 7;
    d.writtenBy = 'dev1';
    d.writtenAt = 1700000000000;
    const back = parseVaultDoc(serializeVaultDoc(d));
    expect(back).toEqual(d);
  });

  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

  it('rejects a newer format with unsupported_format', () => {
    const d = { ...sample(), format: 2 };
    expect(() => parseVaultDoc(enc(d))).toThrowError(expect.objectContaining({ code: 'unsupported_format' }));
  });

  const bad: [string, Uint8Array][] = [
    ['not json', new TextEncoder().encode('{nope')],
    ['invalid utf-8', new Uint8Array([0xff, 0xfe])],
    ['no format', enc({ seq: 1 })],
    ['array', enc([])],
    ['bad seq', enc({ ...sample(), seq: 1.5 })],
    ['missing nodes', enc({ format: 1, seq: 0, writtenBy: '', writtenAt: 0 })],
    ['malformed node', enc({ ...sample(), nodes: { ...sample().nodes, a: { guid: 'a', kind: 'bookmark', title: 1 } } })],
    ['invalid tree', enc({ ...sample(), nodes: { ...sample().nodes, x: { guid: 'x', kind: 'bookmark', title: 'x', url: 'u' } } })],
  ];
  it.each(bad)('rejects %s with bad_format', (_name, bytes) => {
    try {
      parseVaultDoc(bytes);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(VaultDocError);
      expect((e as VaultDocError).code).toBe('bad_format');
    }
  });

  it('drops unknown node fields', () => {
    const d = sample() as unknown as { nodes: Record<string, Record<string, unknown>> };
    d.nodes.a!.extra = 'x';
    const back = parseVaultDoc(enc(d));
    expect(back.nodes.a).toEqual({ guid: 'a', kind: 'bookmark', title: 'a', url: 'https://a.example/' });
  });
});
