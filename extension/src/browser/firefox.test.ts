import { describe, expect, it } from 'vitest';
import { FakeBookmarks } from '../../test/fakes/bookmarks';
import { ROOT_MENU, ROOT_MOBILE, ROOT_OTHER, ROOT_TOOLBAR } from '../model/vault';
import { AnchorMissingError, BookmarkRejectedError, NonEmptyFolderError } from './adapter';
import { FirefoxAdapter } from './firefox';

const setup = () => {
  const fake = new FakeBookmarks('firefox');
  return { fake, adapter: new FirefoxAdapter(fake) };
};
const T = 'toolbar_____';
const dump = (fake: FakeBookmarks) => fake.childIds(T).map((c) => fake.node(c)!.title || '|');

describe('FirefoxAdapter', () => {
  it('maps the fixed root GUIDs one to one', async () => {
    const { adapter } = setup();
    const r = await adapter.resolveRoots();
    expect(r).toEqual({
      status: 'ok',
      pins: { [ROOT_TOOLBAR]: ROOT_TOOLBAR, [ROOT_MENU]: ROOT_MENU, [ROOT_OTHER]: ROOT_OTHER, [ROOT_MOBILE]: ROOT_MOBILE },
      nativeSyncDetected: false,
    });
  });

  it('leaves out a root this Firefox lacks and refuses to write into it', async () => {
    const { fake, adapter } = setup();
    fake.dropRoot('mobile______');
    const r = await adapter.resolveRoots();
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.pins[ROOT_MOBILE]).toBeUndefined();
    await expect(adapter.ensureRoot(ROOT_MOBILE, r.pins)).rejects.toBeInstanceOf(BookmarkRejectedError);
  });

  it('hides separators from reads', async () => {
    const { fake, adapter } = setup();
    await fake.addBookmark(T, 'a', 'https://a.example/');
    await fake.createSeparator(T);
    await fake.addBookmark(T, 'b', 'https://b.example/');
    const r = await adapter.resolveRoots();
    if (r.status !== 'ok') throw new Error();
    const tree = await adapter.readTree(r.pins);
    expect(tree.nodes.get(T)!.children!.map((c) => tree.nodes.get(c)!.title)).toEqual(['a', 'b']);
  });

  it('positions by anchor with separators present, honoring Firefox move semantics', async () => {
    const { fake, adapter } = setup();
    const a = await fake.addBookmark(T, 'a', 'https://a.example/');
    await fake.createSeparator(T);
    const b = await fake.addBookmark(T, 'b', 'https://b.example/');
    const c = await fake.addBookmark(T, 'c', 'https://c.example/');
    expect(dump(fake)).toEqual(['a', '|', 'b', 'c']);

    await adapter.moveAfter(c.id, T, a.id); // up, across the separator
    expect(dump(fake)).toEqual(['a', 'c', '|', 'b']);
    await adapter.moveAfter(a.id, T, b.id); // down to the end
    expect(dump(fake)).toEqual(['c', '|', 'b', 'a']);
    await adapter.moveAfter(b.id, T, null); // to the front
    expect(dump(fake)).toEqual(['b', 'c', '|', 'a']);
    await adapter.moveAfter(c.id, T, b.id); // already in place
    expect(dump(fake)).toEqual(['b', 'c', '|', 'a']);
    await adapter.create(T, c.id, { title: 'n', url: 'https://n.example/' });
    expect(dump(fake)).toEqual(['b', 'c', 'n', '|', 'a']);
  });

  it('turns privileged-URL refusals into BookmarkRejectedError', async () => {
    const { fake, adapter } = setup();
    await expect(adapter.create(T, null, { title: 'js', url: 'javascript:alert(1)' })).rejects.toBeInstanceOf(BookmarkRejectedError);
    const ok = await fake.addBookmark(T, 'ok', 'https://ok.example/');
    await expect(adapter.update(ok.id, { url: 'about:config' })).rejects.toBeInstanceOf(BookmarkRejectedError);
  });

  it('returns the canonicalized URL (this Firefox drops an empty fragment)', async () => {
    const { adapter } = setup();
    expect((await adapter.create(T, null, { title: 'x', url: 'https://Example.com/#' })).url).toBe('https://example.com/');
  });

  it('refuses to remove a non-empty folder', async () => {
    const { fake, adapter } = setup();
    const f = await fake.addFolder(T, 'f');
    await fake.addBookmark(f.id, 'x', 'https://x.example/');
    await expect(adapter.remove(f.id)).rejects.toBeInstanceOf(NonEmptyFolderError);
  });

  it('only exposes the events Firefox has', () => {
    const { adapter } = setup();
    expect(adapter.changeEvents()).toHaveLength(4);
    expect(adapter.importEvents()).toBeNull();
  });
});

describe('FirefoxAdapter anchors', () => {
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
