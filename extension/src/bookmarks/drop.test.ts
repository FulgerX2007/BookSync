import { describe, expect, it } from 'vitest';
import { browser } from '../../test/bookmark-trees';
import type { LocalTree } from '../browser/adapter';
import { resolveDrop, zoneAt, type Zone } from './drop';

/** Bookmarks bar: F1/{a, b, c}, F2/{}, F3/{x, Sub/{y}}, d;  Other bookmarks: z */
async function sample() {
  const b = browser('chromium');
  const r = b.fake.roots();
  const f1 = await b.fake.addFolder(r.toolbar, 'F1');
  for (const t of ['a', 'b', 'c']) await b.fake.addBookmark(f1.id, t, `https://${t}.example/`);
  await b.fake.addFolder(r.toolbar, 'F2');
  const f3 = await b.fake.addFolder(r.toolbar, 'F3');
  await b.fake.addBookmark(f3.id, 'x', 'https://x.example/');
  const sub = await b.fake.addFolder(f3.id, 'Sub');
  await b.fake.addBookmark(sub.id, 'y', 'https://y.example/');
  await b.fake.addBookmark(r.toolbar, 'd', 'https://d.example/');
  await b.fake.addBookmark(r.other, 'z', 'https://z.example/');
  return b.tree();
}

/** Titles in, titles out; roots are named "bar" and "other". */
function named(t: LocalTree) {
  const id = (title: string) => {
    if (title === 'bar') return '1';
    if (title === 'other') return '2';
    for (const n of t.nodes.values()) if (n.title === title) return n.id;
    return title;
  };
  const title = (nid: string | null) => (nid === null ? null : nid === '1' ? 'bar' : nid === '2' ? 'other' : t.nodes.get(nid)!.title);
  return (dragged: string[], target: string, zone: Zone, expanded: string[] = []) => {
    const r = resolveDrop(t, dragged.map(id), id(target), zone, new Set(expanded.map(id)));
    if ('noop' in r) return 'noop';
    if ('refused' in r) return 'refused';
    return { parent: title(r.parentId), after: title(r.afterId) };
  };
}

describe('zoneAt', () => {
  it('splits folders into quarters and bookmarks into halves', () => {
    const h = 100;
    expect([0, 24.9, 25, 74.9, 75, 100].map((y) => zoneAt(y, h, true))).toEqual(['before', 'before', 'inside', 'inside', 'after', 'after']);
    expect([0, 49.9, 50, 100].map((y) => zoneAt(y, h, false))).toEqual(['before', 'before', 'after', 'after']);
  });

  it('treats a zero-height row as its middle', () => {
    expect(zoneAt(0, 0, true)).toBe('inside');
    expect(zoneAt(0, 0, false)).toBe('after');
  });
});

describe('resolveDrop', () => {
  it.each([
    ['before a sibling', ['d'], 'b', 'before', [], { parent: 'F1', after: 'a' }],
    ['after a sibling', ['d'], 'b', 'after', [], { parent: 'F1', after: 'b' }],
    ['before the first child', ['d'], 'a', 'before', [], { parent: 'F1', after: null }],
    ['inside an empty collapsed folder', ['d'], 'F2', 'inside', [], { parent: 'F2', after: null }],
    ['inside a collapsed folder (appends)', ['d'], 'F1', 'inside', [], { parent: 'F1', after: 'c' }],
    ['inside a root (appends)', ['z'], 'bar', 'inside', [], { parent: 'bar', after: 'd' }],
    ['after an expanded folder: first child', ['d'], 'F1', 'after', ['F1'], { parent: 'F1', after: null }],
    ['after a collapsed folder: next sibling', ['d'], 'F1', 'after', [], { parent: 'bar', after: 'F1' }],
    ['after an expanded root: first child', ['z'], 'bar', 'after', ['bar'], { parent: 'bar', after: null }],
    ['moves two nodes after a dragged one: anchor skips it', ['a', 'c'], 'a', 'after', [], { parent: 'F1', after: null }],
    ['into another root', ['a'], 'other', 'inside', [], { parent: 'other', after: 'z' }],
  ] as const)('%s', async (_name, dragged, target, zone, expanded, expected) => {
    expect(named(await sample())([...dragged], target, zone, [...expanded])).toEqual(expected);
  });

  it.each([
    ['a root is dragged', ['bar'], 'F2', 'inside', []],
    ['a root is dragged along with a bookmark', ['a', 'other'], 'F2', 'inside', []],
    ['before a root', ['d'], 'bar', 'before', []],
    ['after a collapsed root', ['d'], 'other', 'after', []],
    ['into itself', ['F3'], 'F3', 'inside', []],
    ['into its own descendant', ['F3'], 'Sub', 'inside', []],
    ['beside its own descendant', ['F3'], 'y', 'after', []],
    ['after itself while expanded', ['F3'], 'F3', 'after', ['F3']],
    ['a selection holding the target’s ancestor', ['a', 'F3'], 'Sub', 'inside', []],
    ['inside a bookmark', ['d'], 'a', 'inside', []],
    ['nothing dragged', [], 'F2', 'inside', []],
    ['an unknown target', ['d'], 'nope', 'inside', []],
  ] as const)('refuses: %s', async (_name, dragged, target, zone, expanded) => {
    expect(named(await sample())([...dragged], target, zone, [...expanded])).toBe('refused');
  });

  it.each([
    ['after itself', ['b'], 'b', 'after'],
    ['before itself', ['b'], 'b', 'before'],
    ['before its next sibling', ['b'], 'c', 'before'],
    ['after its previous sibling', ['b'], 'a', 'after'],
    ['inside its own parent when already last', ['d'], 'bar', 'inside'],
    ['two adjacent nodes after the first of them', ['a', 'b'], 'a', 'after'],
  ] as const)('is a no-op: %s', async (_name, dragged, target, zone) => {
    expect(named(await sample())([...dragged], target, zone)).toBe('noop');
  });

  it('drops after an empty expanded root as its first child', async () => {
    const b = browser('firefox');
    await b.fake.addBookmark('toolbar_____', 'a', 'https://a.example/');
    const t = await b.tree();
    const a = [...t.nodes.values()].find((n) => n.title === 'a')!.id;
    expect(resolveDrop(t, [a], 'mobile______', 'after', new Set(['mobile______']))).toEqual({ parentId: 'mobile______', afterId: null });
    expect(resolveDrop(t, [a], 'mobile______', 'after', new Set())).toEqual({ refused: expect.any(String) });
  });
});
