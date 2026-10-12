import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { doc } from '../../test/builders';
import { FakeBookmarks } from '../../test/fakes/bookmarks';
import { ROOT_MENU, ROOT_OTHER, ROOT_TOOLBAR, validateTree, type VaultDoc } from '../model/vault';
import { IdMap, StateStore, type RootPins } from '../storage/state';
import type { BookmarksAdapter } from './adapter';
import { ChromiumAdapter } from './chromium';
import { FirefoxAdapter } from './firefox';
import { project } from './projection';

async function setup(flavor: 'chromium' | 'firefox') {
  const fake = new FakeBookmarks(flavor);
  const adapter: BookmarksAdapter = flavor === 'chromium' ? new ChromiumAdapter(fake) : new FirefoxAdapter(fake);
  const r = await adapter.resolveRoots(null);
  if (r.status !== 'ok') throw new Error('roots');
  return { fake, adapter, pins: r.pins, idMap: new IdMap() };
}

async function projectNow(adapter: BookmarksAdapter, pins: RootPins, idMap: IdMap, base: VaultDoc | null = null, skipped: string[] = []) {
  const d = await project({ tree: await adapter.readTree(pins), idMap, base, skipped: new Set(skipped) });
  expect(validateTree(d)).toEqual([]);
  return d;
}

const titlesUnder = (d: VaultDoc, g: string) => d.nodes[g]!.children!.map((c) => d.nodes[c]!.title);

describe('project', () => {
  it('assigns guids to new nodes and keeps them stable', async () => {
    const { fake, adapter, pins, idMap } = await setup('chromium');
    const f = await fake.addFolder('1', 'Work');
    const b = await fake.addBookmark(f.id, 'Doc', 'https://doc.example/');
    const first = await projectNow(adapter, pins, idMap);
    const second = await projectNow(adapter, pins, idMap);
    expect(second).toEqual(first);
    const fg = idMap.guidOf(f.id)!;
    expect(first.nodes[ROOT_TOOLBAR]!.children).toEqual([fg]);
    expect(first.nodes[fg]!.children).toEqual([idMap.guidOf(b.id)]);
    expect(first.nodes[idMap.guidOf(b.id)!]).toMatchObject({ kind: 'bookmark', title: 'Doc', url: 'https://doc.example/' });
  });

  it('persists newly allocated guids', async () => {
    const store = await StateStore.open('projection-persist');
    const { fake, adapter, pins } = await setup('firefox');
    const b = await fake.addBookmark('toolbar_____', 'x', 'https://x.example/');
    const idMap = await store.loadIdMap();
    await projectNow(adapter, pins, idMap);
    expect((await store.loadIdMap()).guidOf(b.id)).toBe(idMap.guidOf(b.id));
  });

  it('projects the Chromium menu folder as the menu root, not as a child of Other', async () => {
    const { fake, adapter, pins, idMap } = await setup('chromium');
    await fake.addBookmark('2', 'other-bm', 'https://o.example/');
    const { pins: p2, id: menuId } = await adapter.ensureRoot(ROOT_MENU, pins);
    await fake.addBookmark(menuId, 'menu-bm', 'https://m.example/');
    const d = await projectNow(adapter, p2, idMap);
    expect(titlesUnder(d, ROOT_OTHER)).toEqual(['other-bm']);
    expect(titlesUnder(d, ROOT_MENU)).toEqual(['menu-bm']);
  });

  it('carries the menu root from base when the menu folder is missing, so nothing reads as deleted', async () => {
    const { fake, adapter, pins, idMap } = await setup('chromium');
    await fake.addBookmark('1', 'local', 'https://l.example/');
    const base = doc({ [ROOT_MENU]: [{ b: 'm1' }, { f: 'mf', children: [{ b: 'm2' }] }] });
    const d = await projectNow(adapter, pins, idMap, base);
    expect(d.nodes[ROOT_MENU]!.children).toEqual(['m1', 'mf']);
    expect(d.nodes.mf!.children).toEqual(['m2']);
  });

  it('does not duplicate a carried node the browser shows elsewhere', async () => {
    const { fake, adapter, pins, idMap } = await setup('chromium');
    const moved = await fake.addBookmark('1', 'moved', 'https://m1.example/');
    await idMap.set({ localId: moved.id, guid: 'm1' });
    const base = doc({ [ROOT_MENU]: [{ b: 'm1' }, { b: 'm2' }] });
    const d = await projectNow(adapter, pins, idMap, base);
    expect(d.nodes[ROOT_TOOLBAR]!.children).toEqual(['m1']);
    expect(d.nodes[ROOT_MENU]!.children).toEqual(['m2']);
  });

  it('re-inserts skipped nodes at their base position', async () => {
    const { fake, adapter, pins, idMap } = await setup('firefox');
    const a = await fake.addBookmark('toolbar_____', 'a', 'https://a.example/');
    const b = await fake.addBookmark('toolbar_____', 'b', 'https://b.example/');
    await idMap.setMany([
      { localId: a.id, guid: 'a' },
      { localId: b.id, guid: 'b' },
    ]);
    const base = doc({ [ROOT_TOOLBAR]: [{ b: 's0', url: 'javascript:first()' }, { b: 'a' }, { b: 's1', url: 'javascript:x()' }, { b: 'b' }] });
    const d = await projectNow(adapter, pins, idMap, base, ['s0', 's1']);
    expect(d.nodes[ROOT_TOOLBAR]!.children).toEqual(['s0', 'a', 's1', 'b']);
    expect(d.nodes.s1!.url).toBe('javascript:x()');
  });

  it('drops a skipped node whose base parent no longer exists locally', async () => {
    const { adapter, pins, idMap } = await setup('firefox');
    const base = doc({ [ROOT_TOOLBAR]: [{ f: 'gone', children: [{ b: 's', url: 'javascript:x()' }] }] });
    const d = await projectNow(adapter, pins, idMap, base, ['s']);
    expect(d.nodes.s).toBeUndefined();
  });

  it('reads a browser-rewritten URL as the vault URL, but still sees real edits', async () => {
    const { fake, adapter, pins, idMap } = await setup('firefox');
    const n = await fake.addBookmark('toolbar_____', 'x', 'https://x.example/#');
    expect(fake.node(n.id)!.url).toBe('https://x.example/'); // this Firefox dropped the "#"
    await idMap.set({ localId: n.id, guid: 'x', nativeUrl: 'https://x.example/' });
    const base = doc({ [ROOT_TOOLBAR]: [{ b: 'x', url: 'https://x.example/#' }] });

    expect((await projectNow(adapter, pins, idMap, base)).nodes.x!.url).toBe('https://x.example/#');
    await fake.update(n.id, { url: 'https://edited.example/' });
    expect((await projectNow(adapter, pins, idMap, base)).nodes.x!.url).toBe('https://edited.example/');
  });

  it('ignores Firefox separators and keeps sibling order', async () => {
    const { fake, adapter, pins, idMap } = await setup('firefox');
    await fake.addBookmark('toolbar_____', 'a', 'https://a.example/');
    await fake.createSeparator('toolbar_____');
    await fake.addBookmark('toolbar_____', 'b', 'https://b.example/');
    expect(titlesUnder(await projectNow(adapter, pins, idMap), ROOT_TOOLBAR)).toEqual(['a', 'b']);
  });
});
