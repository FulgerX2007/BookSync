import { describe, expect, it } from 'vitest';
import { FakeBookmarks } from '../../test/fakes/bookmarks';
import { ROOT_MENU, ROOT_MOBILE, ROOT_OTHER, ROOT_TOOLBAR } from '../model/vault';
import { AnchorMissingError, BookmarkRejectedError, NonEmptyFolderError, type RootResolution } from './adapter';
import { ChromiumAdapter, MENU_FOLDER_TITLE } from './chromium';

const setup = (opts = {}) => {
  const fake = new FakeBookmarks('chromium', opts);
  return { fake, adapter: new ChromiumAdapter(fake) };
};
const ok = (r: RootResolution) => {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r;
};
const titles = (fake: FakeBookmarks, id: string) => fake.childIds(id).map((c) => fake.node(c)!.title);

describe('ChromiumAdapter roots', () => {
  it('resolves the permanent folders by folderType', async () => {
    const { adapter } = setup();
    const r = ok(await adapter.resolveRoots(null));
    expect(r.pins).toEqual({ [ROOT_TOOLBAR]: '1', [ROOT_OTHER]: '2' });
    expect(r.nativeSyncDetected).toBe(false);
  });

  it('falls back to the legacy ids 1/2', async () => {
    const { adapter } = setup({ legacy: true });
    expect(ok(await adapter.resolveRoots(null)).pins).toEqual({ [ROOT_TOOLBAR]: '1', [ROOT_OTHER]: '2' });
  });

  it('syncs Mobile bookmarks only while Chromium shows it', async () => {
    const { fake, adapter } = setup();
    const hidden = ok(await adapter.resolveRoots(null));
    expect(hidden.pins[ROOT_MOBILE]).toBeUndefined();
    await expect(adapter.ensureRoot(ROOT_MOBILE, hidden.pins)).rejects.toBeInstanceOf(BookmarkRejectedError);
    fake.revealMobile('From phone', 'https://phone.example/');
    const shown = ok(await adapter.resolveRoots(hidden.pins));
    expect(shown.pins[ROOT_MOBILE]).toBe('3');
    const tree = await adapter.readTree(shown.pins);
    expect(tree.nodes.get('3')!.children).toHaveLength(1);
  });

  it('prefers local folders over Google-account folders', async () => {
    const { adapter } = setup({ accountStorage: true });
    const r = ok(await adapter.resolveRoots(null));
    expect(r.pins[ROOT_TOOLBAR]).toBe('1');
    expect(r.nativeSyncDetected).toBe(false);
  });

  it('uses account folders when they are the only ones and flags native sync', async () => {
    const { fake, adapter } = setup({ accountStorage: true });
    for (const id of ['1', '2', '3']) fake.dropRoot(id);
    const r = ok(await adapter.resolveRoots(null));
    expect(r.pins[ROOT_TOOLBAR]).toBe('4');
    expect(r.nativeSyncDetected).toBe(true);
  });

  it('flags native sync when the chosen folders are browser-synced', async () => {
    const { adapter } = setup({ nativeSync: true });
    expect(ok(await adapter.resolveRoots(null)).nativeSyncDetected).toBe(true);
  });

  it('reports roots_changed when a pinned folder disappears', async () => {
    const { fake, adapter } = setup({ accountStorage: true });
    const { pins } = ok(await adapter.resolveRoots(null));
    fake.dropRoot('1');
    expect(await adapter.resolveRoots(pins)).toEqual({ status: 'roots_changed', missing: [ROOT_TOOLBAR] });
  });

  it('flags native sync when a pinned folder starts syncing', async () => {
    const { fake, adapter } = setup();
    const { pins } = ok(await adapter.resolveRoots(null));
    fake.setSyncing('2', true);
    const r = ok(await adapter.resolveRoots(pins));
    expect(r.pins).toEqual(pins);
    expect(r.nativeSyncDetected).toBe(true);
  });
});

describe('ChromiumAdapter menu folder', () => {
  it('creates the Bookmarks Menu folder on demand and reuses it', async () => {
    const { fake, adapter } = setup();
    const { pins } = ok(await adapter.resolveRoots(null));
    const first = await adapter.ensureRoot(ROOT_MENU, pins);
    expect(fake.node(first.id)).toMatchObject({ parentId: '2', title: MENU_FOLDER_TITLE });
    expect(first.pins[ROOT_MENU]).toBe(first.id);
    const second = await adapter.ensureRoot(ROOT_MENU, first.pins);
    expect(second.id).toBe(first.id);
    expect(fake.childIds('2')).toHaveLength(1);
  });

  it('rediscovers an existing Bookmarks Menu folder instead of creating a second one', async () => {
    const { fake, adapter } = setup();
    const existing = await fake.addFolder('2', MENU_FOLDER_TITLE);
    const { pins } = ok(await adapter.resolveRoots(null));
    expect(pins[ROOT_MENU]).toBe(existing.id);
    expect((await adapter.ensureRoot(ROOT_MENU, { ...pins, [ROOT_MENU]: 'gone' })).id).toBe(existing.id);
  });

  it('drops a pinned menu folder the user deleted and recreates it when needed', async () => {
    const { fake, adapter } = setup();
    const { pins } = ok(await adapter.resolveRoots(null));
    const { pins: withMenu, id } = await adapter.ensureRoot(ROOT_MENU, pins);
    await fake.remove(id);
    const r = ok(await adapter.resolveRoots(withMenu));
    expect(r.pins[ROOT_MENU]).toBeUndefined();
    const again = await adapter.ensureRoot(ROOT_MENU, r.pins);
    expect(again.id).not.toBe(id);
  });

  it('reads the menu folder as its own root and hides it from Other bookmarks', async () => {
    const { fake, adapter } = setup();
    await fake.addBookmark('2', 'other-bm', 'https://o.example/');
    const { pins } = ok(await adapter.resolveRoots(null));
    const { pins: p2, id: menuId } = await adapter.ensureRoot(ROOT_MENU, pins);
    await fake.addBookmark(menuId, 'menu-bm', 'https://m.example/');
    const tree = await adapter.readTree(p2);
    expect(tree.roots[ROOT_MENU]).toBe(menuId);
    const other = tree.nodes.get('2')!;
    expect(other.children!.map((c) => tree.nodes.get(c)!.title)).toEqual(['other-bm']);
    expect(tree.nodes.get(menuId)!.children!.map((c) => tree.nodes.get(c)!.title)).toEqual(['menu-bm']);
  });
});

describe('ChromiumAdapter tree and writes', () => {
  it('reads nested folders and skips managed bookmarks', async () => {
    const { fake, adapter } = setup({ managed: true });
    const f = await fake.addFolder('1', 'Work');
    await fake.addBookmark(f.id, 'Doc', 'https://doc.example/');
    const { pins } = ok(await adapter.resolveRoots(null));
    const tree = await adapter.readTree(pins);
    expect(tree.nodes.get(f.id)).toMatchObject({ kind: 'folder', parentId: '1', title: 'Work' });
    expect(tree.nodes.has('50')).toBe(false);
    expect(tree.nodes.has('51')).toBe(false);
    expect(tree.roots).toEqual({ [ROOT_TOOLBAR]: '1', [ROOT_OTHER]: '2' });
  });

  it('positions creates and moves by anchor, honoring Chromium move semantics', async () => {
    const { fake, adapter } = setup();
    const a = await adapter.create('1', null, { title: 'a', url: 'https://a.example/' });
    const b = await adapter.create('1', a.id, { title: 'b', url: 'https://b.example/' });
    const d = await adapter.create('1', b.id, { title: 'd', url: 'https://d.example/' });
    await adapter.create('1', b.id, { title: 'c', url: 'https://c.example/' });
    expect(titles(fake, '1')).toEqual(['a', 'b', 'c', 'd']);

    await adapter.moveAfter(a.id, '1', fake.findByTitle('c')!.id); // move down
    expect(titles(fake, '1')).toEqual(['b', 'c', 'a', 'd']);
    await adapter.moveAfter(d.id, '1', null); // move to front
    expect(titles(fake, '1')).toEqual(['d', 'b', 'c', 'a']);
    await adapter.moveAfter(a.id, '1', d.id); // move up
    expect(titles(fake, '1')).toEqual(['d', 'a', 'b', 'c']);
    await adapter.moveAfter(a.id, '1', d.id); // already in place
    expect(titles(fake, '1')).toEqual(['d', 'a', 'b', 'c']);
    await adapter.moveAfter(b.id, '2', null); // to another folder
    expect(titles(fake, '1')).toEqual(['d', 'a', 'c']);
    expect(titles(fake, '2')).toEqual(['b']);
  });

  it('returns the URL as the browser stored it', async () => {
    const { adapter } = setup();
    const created = await adapter.create('1', null, { title: 'x', url: 'HTTPS://Example.COM' });
    expect(created.url).toBe('https://example.com/');
    expect((await adapter.update(created.id, { url: 'https://example.com/#' })).url).toBe('https://example.com/#');
  });

  it('refuses to remove a non-empty folder', async () => {
    const { fake, adapter } = setup();
    const f = await fake.addFolder('1', 'f');
    await fake.addBookmark(f.id, 'x', 'https://x.example/');
    await expect(adapter.remove(f.id)).rejects.toBeInstanceOf(NonEmptyFolderError);
  });

  it('exposes change and import events', () => {
    const { adapter } = setup();
    expect(adapter.changeEvents()).toHaveLength(5);
    expect(adapter.importEvents()).not.toBeNull();
  });
});

describe('ChromiumAdapter anchors', () => {
  it('raises AnchorMissingError when the anchor vanished from the folder', async () => {
    const { fake, adapter } = setup();
    const toolbar = fake.roots().toolbar;
    const a = await fake.addBookmark(toolbar, 'a', 'https://a.example/');
    const gone = await fake.addBookmark(toolbar, 'gone', 'https://gone.example/');
    await fake.remove(gone.id);
    await expect(adapter.moveAfter(a.id, toolbar, gone.id)).rejects.toBeInstanceOf(AnchorMissingError);
    await expect(adapter.create(toolbar, gone.id, { title: 'n' })).rejects.toThrow(/no longer in the folder/);
  });
});
