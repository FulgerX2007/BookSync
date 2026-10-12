// Bookmark edits for the popup and the manager. Every write goes through the
// adapter, so positions are anchor-based ("after sibling P") and land right
// on both browsers, and roots are locked here whatever the UI shows. Sync
// sees these edits like any other bookmark change.
import { AnchorMissingError, BookmarkRejectedError, NonEmptyFolderError, type BookmarksAdapter, type LocalTree } from '../browser/adapter';
import { isRootId, normalizeSelection } from './tree';

/** Roots (the Chromium "Bookmarks Menu" folder included) are never renamed, moved or deleted. */
export class RootLockedError extends Error {
  constructor() {
    super('Root folders cannot be renamed, moved or deleted.');
    this.name = 'RootLockedError';
  }
}

/** The bookmarks changed between reading the tree and writing; the caller re-reads and retries. */
export class StaleTreeError extends Error {
  constructor(cause?: unknown) {
    super('Bookmarks changed meanwhile; please try again.', { cause });
    this.name = 'StaleTreeError';
  }
}

/** Not a usable URL, or one this browser refuses to bookmark. */
export class InvalidUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUrlError';
  }
}

/** Where a new or moved node goes: after this sibling, first (null), or last. */
export type Position = string | null | 'end';

/** Browsers report a vanished node as "Can't find bookmark…" (Chromium) or "…not found" (Firefox). */
const NOT_FOUND = /not found|can't find|no bookmarks? found/i;

function translate(e: unknown, url?: string): unknown {
  if (e instanceof AnchorMissingError || e instanceof NonEmptyFolderError) return new StaleTreeError(e);
  if (e instanceof BookmarkRejectedError) return new InvalidUrlError(`This browser does not allow bookmarking ${url ?? 'this URL'}.`);
  if (e instanceof Error && NOT_FOUND.test(e.message)) return new StaleTreeError(e);
  return e;
}

async function write<T>(fn: () => Promise<T>, url?: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw translate(e, url);
  }
}

function assertNotRoot(tree: LocalTree, ids: Iterable<string>): void {
  for (const id of ids) if (isRootId(tree, id)) throw new RootLockedError();
}

/** An id the tree no longer has means the caller's view is stale; a bookmark is no folder. */
function folderOf(tree: LocalTree, id: string): string {
  const n = tree.nodes.get(id);
  if (!n) throw new StaleTreeError();
  if (n.kind !== 'folder') throw new Error('Only folders can hold bookmarks.');
  return id;
}

function anchor(tree: LocalTree, parentId: string, after: Position): string | null {
  return after === 'end' ? (tree.nodes.get(parentId)?.children?.at(-1) ?? null) : after;
}

/** A URL a person typed: trimmed, and absolute (the browser canonicalizes the rest). */
export function parseUrl(raw: string): string {
  const url = raw.trim();
  try {
    new URL(url);
  } catch {
    throw new InvalidUrlError('Enter a full URL, like https://example.com/.');
  }
  return url;
}

export async function createBookmark(adapter: BookmarksAdapter, tree: LocalTree, parentId: string, after: Position, props: { title: string; url: string }): Promise<string> {
  const url = parseUrl(props.url);
  const parent = folderOf(tree, parentId);
  const r = await write(() => adapter.create(parent, anchor(tree, parent, after), { title: props.title, url }), url);
  return r.id;
}

export async function createFolder(adapter: BookmarksAdapter, tree: LocalTree, parentId: string, after: Position, title: string): Promise<string> {
  const parent = folderOf(tree, parentId);
  const r = await write(() => adapter.create(parent, anchor(tree, parent, after), { title }));
  return r.id;
}

export async function rename(adapter: BookmarksAdapter, tree: LocalTree, id: string, title: string): Promise<void> {
  assertNotRoot(tree, [id]);
  await write(() => adapter.update(id, { title }));
}

export async function setUrl(adapter: BookmarksAdapter, tree: LocalTree, id: string, raw: string): Promise<void> {
  assertNotRoot(tree, [id]);
  const n = tree.nodes.get(id);
  if (!n) throw new StaleTreeError();
  if (n.kind !== 'bookmark') throw new Error('Folders have no URL.');
  const url = parseUrl(raw);
  await write(() => adapter.update(id, { url }), url);
}

/**
 * Moves the selection to follow `afterId` (null: first) in `parentId`, in
 * tree order, each node anchored after the one moved before it, so their
 * relative order survives. Returns the nodes actually moved.
 */
export async function moveMany(adapter: BookmarksAdapter, tree: LocalTree, ids: Iterable<string>, parentId: string, afterId: string | null): Promise<string[]> {
  const list = [...ids];
  assertNotRoot(tree, list);
  const parent = folderOf(tree, parentId);
  const moving = normalizeSelection(tree, list);
  let after = afterId;
  for (const id of moving) {
    const anchorId = after;
    await write(() => adapter.moveAfter(id, parent, anchorId));
    after = id;
  }
  return moving;
}

/**
 * Deletes the selection, contents first, with remove() only (never
 * removeTree): a folder that gained a child meanwhile stays, with that child.
 * Stops at the first failure, leaving later items untouched.
 */
export async function deleteMany(adapter: BookmarksAdapter, tree: LocalTree, ids: Iterable<string>): Promise<void> {
  const list = [...ids];
  assertNotRoot(tree, list);
  for (const id of normalizeSelection(tree, list)) {
    const order = tree.nodes.get(id)?.kind === 'folder' ? [...(await write(() => adapter.subtreeIds(id))), id] : [id];
    for (const x of order) await write(() => adapter.remove(x));
  }
}
