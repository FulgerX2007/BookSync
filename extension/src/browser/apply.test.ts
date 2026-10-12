import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { doc, outline, type Spec } from '../../test/builders';
import { FakeBookmarks } from '../../test/fakes/bookmarks';
import { ROOT_MENU, ROOT_OTHER, ROOT_TOOLBAR, treesEqual, validateTree, type Guid, type VaultDoc } from '../model/vault';
import { IdMap, StateStore, type RootPins } from '../storage/state';
import type { BookmarksAdapter } from './adapter';
import { ConcurrentEditError, applyOps, planOps, pruneSkipped, rebindPending } from './apply';
import { ChromiumAdapter } from './chromium';
import { FirefoxAdapter } from './firefox';
import { project } from './projection';

const T = ROOT_TOOLBAR;
const O = ROOT_OTHER;
const tree = (toolbar: Spec[], other: Spec[] = [], menu: Spec[] = []) => doc({ [T]: toolbar, [O]: other, [ROOT_MENU]: menu });

interface Env {
  fake: FakeBookmarks;
  adapter: BookmarksAdapter;
  pins: RootPins;
  idMap: IdMap;
  skipped: Set<Guid>;
}

async function env(flavor: 'chromium' | 'firefox', idMap = new IdMap()): Promise<Env> {
  const fake = new FakeBookmarks(flavor);
  const adapter: BookmarksAdapter = flavor === 'chromium' ? new ChromiumAdapter(fake) : new FirefoxAdapter(fake);
  const r = await adapter.resolveRoots(null);
  if (r.status !== 'ok') throw new Error('roots');
  return { fake, adapter, pins: r.pins, idMap, skipped: new Set() };
}

async function projectNow(e: Env, base: VaultDoc | null) {
  const t = await e.adapter.readTree(e.pins);
  return { tree: t, local: await project({ tree: t, idMap: e.idMap, base, skipped: e.skipped }) };
}

/** Applies merged and returns the ops and writes; asserts the browser now projects to merged. */
async function applyMerged(e: Env, merged: VaultDoc, base: VaultDoc | null = null) {
  const { tree: t, local } = await projectNow(e, base);
  const ops = planOps(local, merged, (g) => e.idMap.localIdOf(g) !== undefined, e.skipped);
  const res = await applyOps(ops, { adapter: e.adapter, tree: t, idMap: e.idMap, pins: e.pins, skipped: e.skipped });
  e.pins = res.pins;
  e.skipped = pruneSkipped(res.skipped, merged);
  const { local: after } = await projectNow(e, merged);
  expect(validateTree(after)).toEqual([]);
  expect(outline(after)).toBe(outline(merged));
  expect(treesEqual(after, merged)).toBe(true);
  return { ops, res };
}

const nested = () =>
  tree(
    [{ b: 'a', url: 'https://a.example/' }, { f: 'work', title: 'Work', children: [{ b: 'doc', url: 'https://doc.example/' }, { f: 'deep', children: [{ b: 'x' }] }] }],
    [{ b: 'o1' }],
  );

describe('planOps', () => {
  it('orders parents before children and removals bottom-up, last', () => {
    const local = tree([{ f: 'old', children: [{ b: 'y' }] }]);
    const merged = tree([{ f: 'new', children: [{ b: 'b' }] }]);
    const native = new Set(['old', 'y']);
    const ops = planOps(local, merged, (g) => native.has(g), new Set());
    expect(ops.map((o) => `${o.kind}:${o.guid}`)).toEqual(['create:new', 'create:b', 'remove:y', 'remove:old']);
  });

  it('needs a single move for a single reorder', () => {
    const local = tree([{ b: 'a' }, { b: 'b' }, { b: 'c' }, { b: 'd' }]);
    const merged = tree([{ b: 'b' }, { b: 'c' }, { b: 'a' }, { b: 'd' }]);
    const ops = planOps(local, merged, () => true, new Set());
    expect(ops).toEqual([{ kind: 'move', guid: 'a', parent: T, after: ['c', 'b'] }]);
  });

  it('never re-creates skipped nodes', () => {
    const local = tree([{ b: 's', url: 'javascript:x()' }]);
    const merged = tree([{ b: 's', url: 'javascript:x()' }, { b: 'n' }]);
    const ops = planOps(local, merged, (g) => g !== 's', new Set(['s']));
    expect(ops.map((o) => `${o.kind}:${o.guid}`)).toEqual(['create:n']);
  });
});

describe.each(['chromium', 'firefox'] as const)('applyOps on %s', (flavor) => {
  it('builds a nested tree into an empty browser', async () => {
    const e = await env(flavor);
    await applyMerged(e, nested());
  });

  it('applies renames, URL changes, cross-folder moves, reorders, creates and subtree deletes', async () => {
    const e = await env(flavor);
    await applyMerged(e, nested());
    const next = tree(
      [
        { f: 'work', title: 'Work (renamed)', children: [{ f: 'deep', children: [{ b: 'x' }, { b: 'a', url: 'https://a2.example/' }] }, { b: 'new' }] },
      ],
      [{ f: 'nf', children: [{ b: 'nb' }] }, { b: 'o1', title: 'Other 1' }],
    );
    await applyMerged(e, next, nested());
  });

  it('is a no-op when the browser already matches', async () => {
    const e = await env(flavor);
    await applyMerged(e, nested());
    const before = e.fake.writes;
    const { ops } = await applyMerged(e, nested(), nested());
    expect(ops).toEqual([]);
    expect(e.fake.writes).toBe(before);
  });

  it('reorders with one browser write', async () => {
    const e = await env(flavor);
    const start = tree([{ b: 'a' }, { b: 'b' }, { b: 'c' }, { b: 'd' }]);
    await applyMerged(e, start);
    const before = e.fake.writes;
    await applyMerged(e, tree([{ b: 'b' }, { b: 'c' }, { b: 'a' }, { b: 'd' }]), start);
    expect(e.fake.writes - before).toBe(1);
  });

  it('keeps URLs the browser canonicalizes from reading as edits', async () => {
    const e = await env(flavor);
    const merged = tree([{ b: 'h', url: 'https://example.com/#' }, { b: 'u', url: 'HTTPS://Upper.EXAMPLE/Path' }]);
    await applyMerged(e, merged);
    const { ops } = await applyMerged(e, merged, merged);
    expect(ops).toEqual([]);
  });
});

describe('applyOps edge cases', () => {
  it('skips bookmarks Firefox refuses and does not report them as deleted later', async () => {
    const e = await env('firefox');
    const merged = tree([{ b: 'a' }, { b: 'js', url: 'javascript:alert(1)' }, { b: 'c' }]);
    await applyMerged(e, merged);
    expect(e.skipped).toEqual(new Set(['js']));
    expect(e.fake.findByTitle('js')).toBeUndefined();
    const { ops } = await applyMerged(e, merged, merged);
    expect(ops).toEqual([]);
  });

  it('drops the native copy when Firefox refuses a URL update', async () => {
    const e = await env('firefox');
    const start = tree([{ b: 'a' }]);
    await applyMerged(e, start);
    await applyMerged(e, tree([{ b: 'a', url: 'about:config' }]), start);
    expect(e.skipped).toEqual(new Set(['a']));
    expect(e.fake.childIds('toolbar_____')).toEqual([]);
  });

  it('forgets skipped guids the merged tree no longer has', async () => {
    const e = await env('firefox');
    const merged = tree([{ b: 'js', url: 'javascript:1' }]);
    await applyMerged(e, merged);
    await applyMerged(e, tree([]), merged);
    expect(e.skipped.size).toBe(0);
  });

  it('recreates the Chromium menu folder when the merged tree has menu content', async () => {
    const e = await env('chromium');
    const merged = tree([], [{ b: 'o' }], [{ b: 'm1' }, { f: 'mf', children: [{ b: 'm2' }] }]);
    await applyMerged(e, merged);
    const menuId = e.pins[ROOT_MENU]!;
    expect(e.fake.node(menuId)).toMatchObject({ title: 'Bookmarks Menu', parentId: '2' });
  });

  it('carries menu content from base and recreates it after the user deleted the folder', async () => {
    const e = await env('chromium');
    const merged = tree([], [], [{ b: 'm1' }]);
    await applyMerged(e, merged);
    const menuId = e.pins[ROOT_MENU]!;
    await e.fake.remove(e.fake.childIds(menuId)[0]!);
    await e.fake.remove(menuId);
    await e.idMap.remove(e.idMap.localIdOf('m1') ?? '');
    const r = await e.adapter.resolveRoots(e.pins);
    if (r.status !== 'ok') throw new Error('roots');
    e.pins = r.pins;
    // The projection still shows m1 (carried from base): no deletion; the apply recreates it.
    const { local } = await projectNow(e, merged);
    expect(local.nodes[ROOT_MENU]!.children).toEqual(['m1']);
    await applyMerged(e, merged, merged);
  });

  it('raises ConcurrentEditError when a folder to delete gained a child, keeping the child', async () => {
    const e = await env('chromium');
    const start = tree([{ f: 'f', children: [{ b: 'x' }] }]);
    await applyMerged(e, start);
    const { tree: t, local } = await projectNow(e, start);
    const merged = tree([]);
    const ops = planOps(local, merged, (g) => e.idMap.localIdOf(g) !== undefined, e.skipped);
    // The user drops a new bookmark into f after we projected.
    await e.fake.addBookmark(e.idMap.localIdOf('f')!, 'user-added', 'https://u.example/');
    await expect(applyOps(ops, { adapter: e.adapter, tree: t, idMap: e.idMap, pins: e.pins, skipped: e.skipped })).rejects.toBeInstanceOf(ConcurrentEditError);
    expect(e.fake.findByTitle('user-added')).toBeDefined();
  });

  it('recovers from an apply interrupted between a browser write and its id-map write, without duplicates', async () => {
    const store = await StateStore.open('apply-crash');
    const e = await env('chromium', await store.loadIdMap());
    const merged = nested();

    // Simulate a crash: the 3rd create reaches the browser but the extension dies before recording it.
    let creates = 0;
    const realCreate = e.adapter.create.bind(e.adapter);
    e.adapter.create = async (...args) => {
      const r = await realCreate(...args);
      if (++creates === 3) throw new Error('worker killed');
      return r;
    };
    const { tree: t, local } = await projectNow(e, null);
    const ops = planOps(local, merged, (g) => e.idMap.localIdOf(g) !== undefined, e.skipped);
    await expect(applyOps(ops, { adapter: e.adapter, tree: t, idMap: e.idMap, pins: e.pins, skipped: e.skipped })).rejects.toThrow('worker killed');
    e.adapter.create = realCreate;

    // Restart: in-memory state is gone; reload from storage and rebind against pendingApply.
    e.idMap = await store.loadIdMap();
    const rebound = await rebindPending(await e.adapter.readTree(e.pins), merged, e.idMap);
    expect(rebound).toBe(1);
    await applyMerged(e, merged);
    const titles = (await e.adapter.readTree(e.pins)).nodes;
    expect([...titles.values()].filter((n) => n.title === 'doc')).toHaveLength(1);
  });
});
