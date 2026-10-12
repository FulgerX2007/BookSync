// Fake browsers plus the real adapter, for tests of src/bookmarks: trees are
// always read through the adapter, exactly as the UI does.
import type { BookmarksAdapter, LocalTree } from '../src/browser/adapter';
import { ChromiumAdapter } from '../src/browser/chromium';
import { FirefoxAdapter } from '../src/browser/firefox';
import type { RootPins } from '../src/storage/state';
import { FakeBookmarks, type FakeFlavor, type FakeOptions } from './fakes/bookmarks';

export interface Browser {
  fake: FakeBookmarks;
  adapter: BookmarksAdapter;
  pins: () => Promise<RootPins>;
  /** Re-reads the tree through the adapter (fresh pins, as the UI does). */
  tree: () => Promise<LocalTree>;
}

export function browser(flavor: FakeFlavor, opts: FakeOptions = {}): Browser {
  const fake = new FakeBookmarks(flavor, opts);
  const adapter = flavor === 'chromium' ? new ChromiumAdapter(fake) : new FirefoxAdapter(fake);
  const pins = async () => {
    const r = await adapter.resolveRoots(null);
    if (r.status !== 'ok') throw new Error(`roots: ${JSON.stringify(r)}`);
    return r.pins;
  };
  return { fake, adapter, pins, tree: async () => adapter.readTree(await pins()) };
}

/** Node ids by title (titles are unique in these tests). */
export function idOf(t: LocalTree, title: string): string {
  for (const n of t.nodes.values()) if (n.title === title) return n.id;
  throw new Error(`no node titled ${title}`);
}

/** Child titles of a node, for compact assertions. */
export function childTitles(t: LocalTree, id: string): string[] {
  return (t.nodes.get(id)?.children ?? []).map((c) => t.nodes.get(c)!.title);
}
