import { describe, expect, it } from 'vitest';
import { browser, idOf, type Browser } from '../../test/bookmark-trees';
import type { FakeBookmarks } from '../../test/fakes/bookmarks';
import { MENU_FOLDER_TITLE } from '../browser/chromium';
import { InvalidUrlError, RootLockedError, StaleTreeError, createBookmark, createFolder, deleteMany, moveMany, parseUrl, rename, setUrl } from './ops';

/** Native child order, separators as "|". */
const native = (fake: FakeBookmarks, id: string) => fake.childIds(id).map((c) => (fake.node(c)!.type === 'separator' ? '|' : fake.node(c)!.title));

/** Toolbar: List/{a, b, c, d}, Box/{}, Nest/{Inner/{x}}; Other: z */
async function sample(flavor: 'chromium' | 'firefox') {
  const b = browser(flavor);
  const r = b.fake.roots();
  const list = await b.fake.addFolder(r.toolbar, 'List');
  for (const t of ['a', 'b', 'c', 'd']) await b.fake.addBookmark(list.id, t, `https://${t}.example/`);
  await b.fake.addFolder(r.toolbar, 'Box');
  const nest = await b.fake.addFolder(r.toolbar, 'Nest');
  const inner = await b.fake.addFolder(nest.id, 'Inner');
  await b.fake.addBookmark(inner.id, 'x', 'https://x.example/');
  await b.fake.addBookmark(r.other, 'z', 'https://z.example/');
  return { ...b, t: await b.tree() };
}

describe('parseUrl', () => {
  it('trims and accepts absolute URLs only', () => {
    expect(parseUrl('  https://example.com/a  ')).toBe('https://example.com/a');
    expect(() => parseUrl('example.com')).toThrow(InvalidUrlError);
    expect(() => parseUrl('')).toThrow(InvalidUrlError);
  });
});

describe.each(['chromium', 'firefox'] as const)('ops on %s', (flavor) => {
  describe('create, rename, setUrl', () => {
    it('creates bookmarks and folders first, after a sibling, or at the end', async () => {
      const { fake, adapter, t } = await sample(flavor);
      const list = idOf(t, 'List');
      await createBookmark(adapter, t, list, 'end', { title: 'last', url: 'https://last.example/' });
      await createBookmark(adapter, t, list, null, { title: 'first', url: 'https://first.example/' });
      await createFolder(adapter, t, list, idOf(t, 'b'), 'after b');
      expect(native(fake, list)).toEqual(['first', 'a', 'b', 'after b', 'c', 'd', 'last']);
    });

    it('returns the new id', async () => {
      const { fake, adapter, t } = await sample(flavor);
      const id = await createFolder(adapter, t, idOf(t, 'Box'), 'end', 'New');
      expect(fake.node(id)!.title).toBe('New');
    });

    it('renames and changes URLs', async () => {
      const { fake, adapter, t } = await sample(flavor);
      await rename(adapter, t, idOf(t, 'List'), 'Renamed');
      await setUrl(adapter, t, idOf(t, 'a'), ' https://new.example/path ');
      expect(fake.findByTitle('Renamed')).toBeDefined();
      expect(fake.node(idOf(t, 'a'))!.url).toBe('https://new.example/path');
    });

    it('rejects an invalid URL before writing anything', async () => {
      const { fake, adapter, t } = await sample(flavor);
      const writes = fake.writes;
      await expect(setUrl(adapter, t, idOf(t, 'a'), 'not a url')).rejects.toBeInstanceOf(InvalidUrlError);
      await expect(createBookmark(adapter, t, idOf(t, 'Box'), 'end', { title: 'x', url: 'nope' })).rejects.toBeInstanceOf(InvalidUrlError);
      expect(fake.writes).toBe(writes);
    });

    it('refuses a URL on a folder and a bookmark as a parent', async () => {
      const { adapter, t } = await sample(flavor);
      await expect(setUrl(adapter, t, idOf(t, 'List'), 'https://x.example/')).rejects.toThrow(/no URL/);
      await expect(createFolder(adapter, t, idOf(t, 'a'), 'end', 'x')).rejects.toThrow(/Only folders/);
    });
  });

  describe('moveMany', () => {
    it('moves down and up within a folder (both browsers’ index semantics)', async () => {
      const { fake, adapter, t } = await sample(flavor);
      const list = idOf(t, 'List');
      await moveMany(adapter, t, [idOf(t, 'a')], list, idOf(t, 'c'));
      expect(native(fake, list)).toEqual(['b', 'c', 'a', 'd']);
      await moveMany(adapter, t, [idOf(t, 'd')], list, null);
      expect(native(fake, list)).toEqual(['d', 'b', 'c', 'a']);
      await moveMany(adapter, t, [idOf(t, 'b')], list, idOf(t, 'a'));
      expect(native(fake, list)).toEqual(['d', 'c', 'a', 'b']);
    });

    it('moves into another folder, first or after a sibling', async () => {
      const { fake, adapter, t } = await sample(flavor);
      const box = idOf(t, 'Box');
      await moveMany(adapter, t, [idOf(t, 'b')], box, null);
      await moveMany(adapter, t, [idOf(t, 'z')], box, idOf(t, 'b'));
      await moveMany(adapter, t, [idOf(t, 'c')], box, null);
      expect(native(fake, box)).toEqual(['c', 'b', 'z']);
      expect(native(fake, idOf(t, 'List'))).toEqual(['a', 'd']);
    });

    it('keeps the relative order of a multi-move and skips nodes inside selected folders', async () => {
      const { fake, adapter, t } = await sample(flavor);
      const box = idOf(t, 'Box');
      // Passed out of order, with x inside the selected Nest.
      const moved = await moveMany(adapter, t, [idOf(t, 'd'), idOf(t, 'x'), idOf(t, 'Nest'), idOf(t, 'b')], box, null);
      expect(moved).toEqual([idOf(t, 'b'), idOf(t, 'd'), idOf(t, 'Nest')]);
      expect(native(fake, box)).toEqual(['b', 'd', 'Nest']);
      expect(native(fake, idOf(t, 'Inner'))).toEqual(['x']);
    });

    it('handles an anchor that is one of the moved nodes', async () => {
      const { fake, adapter, t } = await sample(flavor);
      const list = idOf(t, 'List');
      await moveMany(adapter, t, [idOf(t, 'b'), idOf(t, 'd')], list, idOf(t, 'b'));
      expect(native(fake, list)).toEqual(['a', 'b', 'd', 'c']);
    });

    it('does nothing for an empty selection', async () => {
      const { fake, adapter, t } = await sample(flavor);
      const writes = fake.writes;
      expect(await moveMany(adapter, t, [], idOf(t, 'Box'), null)).toEqual([]);
      expect(fake.writes).toBe(writes);
    });
  });

  describe('deleteMany', () => {
    it('deletes bookmarks and whole folders, contents first', async () => {
      const { fake, adapter, t } = await sample(flavor);
      await deleteMany(adapter, t, [idOf(t, 'Nest'), idOf(t, 'b'), idOf(t, 'x')]);
      expect(native(fake, fake.roots().toolbar)).toEqual(['List', 'Box']);
      expect(native(fake, idOf(t, 'List'))).toEqual(['a', 'c', 'd']);
      expect(fake.findByTitle('x')).toBeUndefined();
    });

    it('stops at a folder that gained a child meanwhile, keeping it, the child and later items', async () => {
      const { fake, adapter, t } = await sample(flavor);
      const list = idOf(t, 'List');
      // The late child arrives after the subtree was captured.
      const racing: Browser['adapter'] = Object.create(adapter);
      racing.subtreeIds = async (id: string) => {
        const ids = await adapter.subtreeIds(id);
        if (id === list) await fake.addBookmark(list, 'late', 'https://late.example/');
        return ids;
      };
      await expect(deleteMany(racing, t, [list, idOf(t, 'z')])).rejects.toBeInstanceOf(StaleTreeError);
      expect(native(fake, list)).toEqual(['late']);
      expect(fake.findByTitle('z')).toBeDefined();
    });
  });

  describe('roots are locked', () => {
    it('refuses to rename, move, delete or set the URL of a root, before writing', async () => {
      const { fake, adapter, t } = await sample(flavor);
      const toolbar = fake.roots().toolbar;
      const writes = fake.writes;
      await expect(rename(adapter, t, toolbar, 'x')).rejects.toBeInstanceOf(RootLockedError);
      await expect(setUrl(adapter, t, toolbar, 'https://x.example/')).rejects.toBeInstanceOf(RootLockedError);
      await expect(moveMany(adapter, t, [idOf(t, 'a'), toolbar], idOf(t, 'Box'), null)).rejects.toBeInstanceOf(RootLockedError);
      await expect(deleteMany(adapter, t, [toolbar])).rejects.toBeInstanceOf(RootLockedError);
      expect(fake.writes).toBe(writes);
    });
  });

  describe('stale trees', () => {
    it('reports a vanished anchor, parent or moved node as StaleTreeError', async () => {
      const { fake, adapter, t } = await sample(flavor);
      await fake.remove(idOf(t, 'c'));
      await expect(moveMany(adapter, t, [idOf(t, 'a')], idOf(t, 'List'), idOf(t, 'c'))).rejects.toBeInstanceOf(StaleTreeError);
      await fake.remove(idOf(t, 'Box'));
      await expect(createBookmark(adapter, t, idOf(t, 'Box'), 'end', { title: 'n', url: 'https://n.example/' })).rejects.toBeInstanceOf(StaleTreeError);
      await fake.remove(idOf(t, 'z'));
      await expect(moveMany(adapter, t, [idOf(t, 'z')], idOf(t, 'List'), null)).rejects.toBeInstanceOf(StaleTreeError);
      await expect(deleteMany(adapter, t, [idOf(t, 'z')])).rejects.toBeInstanceOf(StaleTreeError);
      await expect(rename(adapter, t, 'gone', 'x')).rejects.toBeInstanceOf(StaleTreeError);
    });

    it('passes other errors through', async () => {
      const { fake, adapter, t } = await sample(flavor);
      fake.failOnWrite = 1;
      await expect(rename(adapter, t, idOf(t, 'a'), 'x')).rejects.toThrow('simulated browser failure');
    });
  });
});

describe('Firefox specifics', () => {
  it('refuses privileged and file: URLs with a readable message', async () => {
    const { adapter, t } = await sample('firefox');
    const box = idOf(t, 'Box');
    await expect(createBookmark(adapter, t, box, 'end', { title: 'js', url: 'javascript:alert(1)' })).rejects.toThrow(/does not allow bookmarking javascript:alert\(1\)/);
    await expect(createBookmark(adapter, t, box, 'end', { title: 'f', url: 'file:///tmp/x.html' })).rejects.toBeInstanceOf(InvalidUrlError);
    await expect(setUrl(adapter, t, idOf(t, 'a'), 'about:config')).rejects.toBeInstanceOf(InvalidUrlError);
  });

  it('keeps separators in place; "before X" across a separator lands right after the anchor', async () => {
    const { fake, adapter, t } = await sample('firefox');
    const list = idOf(t, 'List');
    // List: a | b c d   (separator between a and b)
    await fake.createSeparator(list, 1);
    await moveMany(adapter, t, [idOf(t, 'd')], list, idOf(t, 'a'));
    expect(native(fake, list)).toEqual(['a', 'd', '|', 'b', 'c']);
    await moveMany(adapter, t, [idOf(t, 'a')], list, idOf(t, 'c'));
    expect(native(fake, list)).toEqual(['d', '|', 'b', 'c', 'a']);
    await deleteMany(adapter, t, [idOf(t, 'b')]);
    expect(native(fake, list)).toEqual(['d', '|', 'c', 'a']);
  });

  it('deletes a folder holding a separator', async () => {
    const { fake, adapter, t } = await sample('firefox');
    const list = idOf(t, 'List');
    await fake.createSeparator(list, 2);
    await deleteMany(adapter, t, [list]);
    expect(native(fake, fake.roots().toolbar)).toEqual(['Box', 'Nest']);
  });
});

describe('Chromium specifics', () => {
  it('uses the Bookmarks Menu folder as a target but locks it like a root', async () => {
    const b = browser('chromium');
    const menu = await b.fake.addFolder('2', MENU_FOLDER_TITLE);
    await b.fake.addBookmark('1', 'a', 'https://a.example/');
    const t = await b.tree();
    await moveMany(b.adapter, t, [idOf(t, 'a')], menu.id, null);
    expect(native(b.fake, menu.id)).toEqual(['a']);
    await expect(rename(b.adapter, t, menu.id, 'Menu')).rejects.toBeInstanceOf(RootLockedError);
    await expect(moveMany(b.adapter, t, [menu.id], '1', null)).rejects.toBeInstanceOf(RootLockedError);
    await expect(deleteMany(b.adapter, t, [menu.id])).rejects.toBeInstanceOf(RootLockedError);
  });

  it('accepts URLs Firefox refuses', async () => {
    const { fake, adapter, t } = await sample('chromium');
    const id = await createBookmark(adapter, t, idOf(t, 'Box'), 'end', { title: 'f', url: 'file:///tmp/x.html' });
    expect(fake.node(id)!.url).toBe('file:///tmp/x.html');
  });
});
