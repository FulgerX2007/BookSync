// Browser bookmark access, normalized across Chromium and Firefox.
//
// The adapter exposes only sync-relevant nodes (no separators, no managed
// folders) and positions writes by anchor ("after sibling P"), computing the
// native index from the folder's current children at write time. That
// absorbs everything that makes native indices differ from vault order:
// Firefox separators, skipped nodes, the Chromium menu folder, and the two
// browsers' different same-parent move semantics.
import { ROOT_MENU, ROOT_MOBILE, ROOT_OTHER, ROOT_TOOLBAR, type RootGuid } from '../model/vault';
import type { RootPins } from '../storage/state';

export type Flavor = 'chromium' | 'firefox';

/** The subset of a browser's BookmarkTreeNode we rely on. */
export interface NativeNode {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  children?: NativeNode[];
  /** Chromium 134+. */
  folderType?: string;
  /** Chromium 134+: synced by the browser's own account sync. */
  syncing?: boolean;
  unmodifiable?: string;
  /** Firefox. */
  type?: 'bookmark' | 'folder' | 'separator';
}

export interface EventLike {
  addListener(cb: (...args: never[]) => void): void;
  removeListener(cb: (...args: never[]) => void): void;
}

/** The subset of the WebExtension `bookmarks` API we use. */
export interface NativeBookmarksApi {
  getTree(): Promise<NativeNode[]>;
  getChildren(id: string): Promise<NativeNode[]>;
  create(details: { parentId?: string; index?: number; title?: string; url?: string }): Promise<NativeNode>;
  update(id: string, changes: { title?: string; url?: string }): Promise<NativeNode>;
  move(id: string, destination: { parentId?: string; index?: number }): Promise<NativeNode>;
  remove(id: string): Promise<void>;
  onCreated: EventLike;
  onRemoved: EventLike;
  onChanged: EventLike;
  onMoved: EventLike;
  onChildrenReordered?: EventLike;
  onImportBegan?: EventLike;
  onImportEnded?: EventLike;
}

export interface LocalNode {
  id: string;
  /** Native parent id; '' for root folders. */
  parentId: string;
  kind: 'folder' | 'bookmark';
  title: string;
  url?: string;
  /** Sync-relevant child ids in native order. */
  children?: string[];
}

export interface LocalTree {
  /** Canonical root guid → native folder id. The Chromium menu folder may be absent. */
  roots: Partial<Record<RootGuid, string>>;
  /** Root folders and all sync-relevant descendants. */
  nodes: Map<string, LocalNode>;
}

export type RootResolution =
  | { status: 'ok'; pins: RootPins; nativeSyncDetected: boolean }
  | { status: 'roots_changed'; missing: RootGuid[] };

/** The browser refused a bookmark (e.g. Firefox rejects privileged URL schemes). */
export class BookmarkRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookmarkRejectedError';
  }
}

/** remove() on a folder that still has children: someone added a child meanwhile. */
export class NonEmptyFolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonEmptyFolderError';
  }
}

export interface BookmarksAdapter {
  readonly flavor: Flavor;
  /** Resolves the native root folders, or verifies previously pinned ones. */
  resolveRoots(pins: RootPins | null): Promise<RootResolution>;
  readTree(pins: RootPins): Promise<LocalTree>;
  /** Native folder for a canonical root, creating the Chromium menu folder on demand. */
  ensureRoot(root: RootGuid, pins: RootPins): Promise<{ id: string; pins: RootPins }>;
  /** Creates a node right after sibling `afterId` (null: first). Returns the stored URL. */
  create(parentId: string, afterId: string | null, props: { title: string; url?: string }): Promise<{ id: string; url?: string }>;
  update(id: string, props: { title?: string; url?: string }): Promise<{ url?: string }>;
  moveAfter(id: string, parentId: string, afterId: string | null): Promise<void>;
  /** Removes a bookmark or an empty folder; NonEmptyFolderError otherwise. */
  remove(id: string): Promise<void>;
  /** All native descendants of a folder (separators included), children before parents. */
  subtreeIds(id: string): Promise<string[]>;
  /** Events that signal a bookmark change by the user (or by us). */
  changeEvents(): EventLike[];
  /** Chromium's bulk-import bracket events, if available. */
  importEvents(): { began: EventLike; ended: EventLike } | null;
}

export const SYNCED_ROOTS: readonly RootGuid[] = [ROOT_TOOLBAR, ROOT_MENU, ROOT_OTHER, ROOT_MOBILE];

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Behaviour shared by both browsers; subclasses supply roots and move semantics. */
export abstract class NativeAdapter implements BookmarksAdapter {
  abstract readonly flavor: Flavor;

  constructor(protected readonly api: NativeBookmarksApi) {}

  abstract resolveRoots(pins: RootPins | null): Promise<RootResolution>;
  abstract ensureRoot(root: RootGuid, pins: RootPins): Promise<{ id: string; pins: RootPins }>;

  /**
   * Native index that puts a node right after `afterId` given the folder's
   * current children. `movingId` is set for moves (it may already be in the folder).
   */
  protected abstract indexAfter(children: NativeNode[], afterId: string | null, movingId?: string): number;

  /** Whether a native node takes part in sync. */
  protected isSyncable(n: NativeNode): boolean {
    return n.type !== 'separator' && n.unmodifiable === undefined && n.folderType !== 'managed';
  }

  /** Children ids of a root folder that are not themselves synced as part of it. */
  protected excludedFromRoot(_root: RootGuid, _pins: RootPins): ReadonlySet<string> {
    return new Set();
  }

  async readTree(pins: RootPins): Promise<LocalTree> {
    const [top] = await this.api.getTree();
    const byId = new Map<string, NativeNode>();
    const index = (n: NativeNode) => {
      byId.set(n.id, n);
      n.children?.forEach(index);
    };
    if (top) index(top);

    const nodes = new Map<string, LocalNode>();
    const roots: Partial<Record<RootGuid, string>> = {};
    const add = (n: NativeNode, parentId: string, exclude: ReadonlySet<string>) => {
      const isBookmark = n.type ? n.type === 'bookmark' : n.url !== undefined;
      const kids = isBookmark ? undefined : (n.children ?? []).filter((c) => this.isSyncable(c) && !exclude.has(c.id));
      nodes.set(n.id, {
        id: n.id,
        parentId,
        kind: isBookmark ? 'bookmark' : 'folder',
        title: n.title,
        ...(isBookmark ? { url: n.url ?? '' } : { children: kids!.map((c) => c.id) }),
      });
      for (const c of kids ?? []) add(c, n.id, new Set());
    };
    for (const root of SYNCED_ROOTS) {
      const id = pins[root];
      const n = id === undefined ? undefined : byId.get(id);
      if (!n) continue;
      roots[root] = n.id;
      add(n, '', this.excludedFromRoot(root, pins));
    }
    return { roots, nodes };
  }

  async create(parentId: string, afterId: string | null, props: { title: string; url?: string }): Promise<{ id: string; url?: string }> {
    const index = this.indexAfter(await this.api.getChildren(parentId), afterId);
    try {
      const n = await this.api.create({ parentId, index, title: props.title, ...(props.url !== undefined ? { url: props.url } : {}) });
      return { id: n.id, ...(n.url !== undefined ? { url: n.url } : {}) };
    } catch (e) {
      if (props.url !== undefined && /url/i.test(message(e))) throw new BookmarkRejectedError(message(e));
      throw e;
    }
  }

  async update(id: string, props: { title?: string; url?: string }): Promise<{ url?: string }> {
    try {
      const n = await this.api.update(id, props);
      return n.url !== undefined ? { url: n.url } : {};
    } catch (e) {
      if (props.url !== undefined && /url/i.test(message(e))) throw new BookmarkRejectedError(message(e));
      throw e;
    }
  }

  async moveAfter(id: string, parentId: string, afterId: string | null): Promise<void> {
    const index = this.indexAfter(await this.api.getChildren(parentId), afterId, id);
    await this.api.move(id, { parentId, index });
  }

  async remove(id: string): Promise<void> {
    try {
      await this.api.remove(id);
    } catch (e) {
      if (/non-empty/i.test(message(e))) throw new NonEmptyFolderError(message(e));
      throw e;
    }
  }

  async subtreeIds(id: string): Promise<string[]> {
    const out: string[] = [];
    for (const c of await this.api.getChildren(id)) {
      if (c.url === undefined && c.type !== 'separator') out.push(...(await this.subtreeIds(c.id)));
      out.push(c.id);
    }
    return out;
  }

  changeEvents(): EventLike[] {
    return [this.api.onCreated, this.api.onRemoved, this.api.onChanged, this.api.onMoved, this.api.onChildrenReordered].filter(
      (e): e is EventLike => e !== undefined,
    );
  }

  importEvents(): { began: EventLike; ended: EventLike } | null {
    return null;
  }
}

/** Position of afterId among children; -1 for "first". Throws if the anchor vanished. */
export function anchorPosition(children: NativeNode[], afterId: string | null): number {
  if (afterId === null) return -1;
  const p = children.findIndex((c) => c.id === afterId);
  if (p < 0) throw new Error(`anchor ${afterId} is no longer in the folder`);
  return p;
}
