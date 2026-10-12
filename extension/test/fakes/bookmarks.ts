// In-memory WebExtension `bookmarks` API with Chromium or Firefox semantics.
// Fidelity matters: Firefox code paths are mostly verified against this fake.
// It reproduces the behaviours that cause real sync bugs:
//   * Chromium's same-parent move index counts positions before removal;
//     Firefox's index is the final position.
//   * URLs are canonicalized on save (and the browsers disagree on details).
//   * remove() rejects non-empty folders.
//   * Firefox has separators and rejects privileged URL schemes.
//   * Chromium may have a managed (read-only) folder and account-storage roots.
//   * Each browser fires its own set of events.
import type { EventLike, NativeBookmarksApi, NativeNode } from '../../src/browser/adapter';

export type FakeFlavor = 'chromium' | 'firefox';

export interface FakeOptions {
  /** Chromium < 134: no folderType/syncing fields. */
  legacy?: boolean;
  /** Chromium 134+ signed in with account storage: extra account roots with syncing=true. */
  accountStorage?: boolean;
  /** Mark the local permanent folders as synced by the browser (old full-sync mode). */
  nativeSync?: boolean;
  /** Add a managed (policy) folder. */
  managed?: boolean;
}

interface FNode {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  type: 'bookmark' | 'folder' | 'separator';
  children?: string[];
  folderType?: string;
  syncing?: boolean;
  unmodifiable?: string;
  dateAdded: number;
}

type Listener = (...args: unknown[]) => void;

export class FakeEvent implements EventLike {
  private listeners = new Set<Listener>();
  addListener(cb: (...args: never[]) => void): void {
    this.listeners.add(cb as Listener);
  }
  removeListener(cb: (...args: never[]) => void): void {
    this.listeners.delete(cb as Listener);
  }
  hasListeners(): boolean {
    return this.listeners.size > 0;
  }
  dispatch(...args: unknown[]): void {
    for (const l of [...this.listeners]) l(...args);
  }
}

const FIREFOX_ROOTS = ['menu________', 'toolbar_____', 'unfiled_____', 'mobile______'] as const;
const FIREFOX_ROOT_TITLES: Record<string, string> = {
  menu________: 'Bookmarks Menu',
  toolbar_____: 'Bookmarks Toolbar',
  unfiled_____: 'Other Bookmarks',
  mobile______: 'Mobile Bookmarks',
};
const PRIVILEGED = /^(javascript|data|file|chrome|resource|about|moz-extension|view-source):/i;

export class FakeBookmarks implements NativeBookmarksApi {
  readonly onCreated = new FakeEvent();
  readonly onRemoved = new FakeEvent();
  readonly onChanged = new FakeEvent();
  readonly onMoved = new FakeEvent();
  readonly onChildrenReordered?: FakeEvent;
  readonly onImportBegan?: FakeEvent;
  readonly onImportEnded?: FakeEvent;

  /** Number of write calls, to assert minimal operations. */
  writes = 0;
  /** Makes the next create/update/move/remove call (or the nth, 1-based) fail. */
  failOnWrite: number | null = null;

  private nodes = new Map<string, FNode>();
  private nextId = 100;
  private clock = 1_700_000_000_000;
  readonly rootId: string;

  constructor(
    readonly flavor: FakeFlavor,
    readonly options: FakeOptions = {},
  ) {
    if (flavor === 'chromium') {
      this.onChildrenReordered = new FakeEvent();
      this.onImportBegan = new FakeEvent();
      this.onImportEnded = new FakeEvent();
      this.rootId = '0';
      this.put({ id: '0', title: '', type: 'folder', children: [] });
      const modern = !options.legacy;
      const permanent: [string, string, string][] = [
        ['1', 'Bookmarks bar', 'bookmarks-bar'],
        ['2', 'Other bookmarks', 'other'],
        ['3', 'Mobile bookmarks', 'mobile'],
      ];
      for (const [id, title, folderType] of permanent) {
        this.putChild({
          id,
          parentId: '0',
          title,
          type: 'folder',
          children: [],
          ...(modern ? { folderType, syncing: options.nativeSync === true } : {}),
        });
      }
      if (options.accountStorage) {
        permanent.forEach(([, title, folderType], i) =>
          this.putChild({ id: String(4 + i), parentId: '0', title, type: 'folder', children: [], folderType, syncing: true }),
        );
      }
      if (options.managed) {
        this.putChild({ id: '50', parentId: '0', title: 'Managed', type: 'folder', children: [], folderType: 'managed', syncing: false, unmodifiable: 'managed' });
        this.putChild({ id: '51', parentId: '50', title: 'Intranet', url: 'https://intranet.example/', type: 'bookmark', unmodifiable: 'managed' });
      }
    } else {
      this.rootId = 'root________';
      this.put({ id: this.rootId, title: '', type: 'folder', children: [] });
      for (const id of FIREFOX_ROOTS) this.putChild({ id, parentId: this.rootId, title: FIREFOX_ROOT_TITLES[id]!, type: 'folder', children: [] });
    }
  }

  // ---- WebExtension API ----------------------------------------------------

  async getTree(): Promise<NativeNode[]> {
    return [this.toNative(this.rootId, true)];
  }

  async getChildren(id: string): Promise<NativeNode[]> {
    const n = this.must(id);
    return (n.children ?? []).map((c) => this.toNative(c, false));
  }

  async get(id: string): Promise<NativeNode[]> {
    return [this.toNative(this.must(id).id, false)];
  }

  async create(details: { parentId?: string; index?: number; title?: string; url?: string }): Promise<NativeNode> {
    this.countWrite();
    const parentId = details.parentId ?? (this.flavor === 'chromium' ? '2' : 'unfiled_____');
    const parent = this.mustFolder(parentId);
    this.assertWritable(parent, 'create in');
    const isBookmark = details.url !== undefined;
    const url = isBookmark ? this.canonicalize(details.url!) : undefined;
    const id = this.newId();
    this.put({
      id,
      parentId,
      title: details.title ?? '',
      type: isBookmark ? 'bookmark' : 'folder',
      ...(isBookmark ? { url } : { children: [] }),
    });
    const index = clamp(details.index ?? parent.children!.length, 0, parent.children!.length);
    parent.children!.splice(index, 0, id);
    const native = this.toNative(id, false);
    this.onCreated.dispatch(id, native);
    return native;
  }

  /** Test helper: Firefox separator. */
  async createSeparator(parentId: string, index?: number): Promise<string> {
    if (this.flavor !== 'firefox') throw new Error('separators are Firefox-only');
    const parent = this.mustFolder(parentId);
    const id = this.newId();
    this.put({ id, parentId, title: '', type: 'separator', url: 'data:' });
    parent.children!.splice(clamp(index ?? parent.children!.length, 0, parent.children!.length), 0, id);
    this.onCreated.dispatch(id, this.toNative(id, false));
    return id;
  }

  async update(id: string, changes: { title?: string; url?: string }): Promise<NativeNode> {
    this.countWrite();
    const n = this.must(id);
    this.assertWritable(n, 'update');
    if (this.isRoot(n)) throw new Error("Can't modify the root bookmark folders.");
    if (changes.url !== undefined) {
      if (n.type !== 'bookmark') throw new Error("Can't set URL of a bookmark folder.");
      n.url = this.canonicalize(changes.url);
    }
    if (changes.title !== undefined) n.title = changes.title;
    this.onChanged.dispatch(id, { title: n.title, ...(n.url !== undefined ? { url: n.url } : {}) });
    return this.toNative(id, false);
  }

  async move(id: string, destination: { parentId?: string; index?: number }): Promise<NativeNode> {
    this.countWrite();
    const n = this.must(id);
    if (this.isRoot(n)) throw new Error("Can't move the root bookmark folders.");
    this.assertWritable(n, 'move');
    const oldParent = this.mustFolder(n.parentId!);
    const newParent = this.mustFolder(destination.parentId ?? n.parentId!);
    this.assertWritable(newParent, 'move into');
    for (let p: FNode | undefined = newParent; p; p = p.parentId ? this.nodes.get(p.parentId) : undefined) {
      if (p.id === id) throw new Error("Can't move a folder into itself or its descendant.");
    }
    const oldIndex = oldParent.children!.indexOf(id);
    if (oldParent === newParent) {
      const len = oldParent.children!.length;
      let index = destination.index ?? len;
      if (this.flavor === 'chromium') {
        // Chromium: insert before the node currently at `index` (pre-removal).
        index = clamp(index, 0, len);
        if (index === oldIndex || index === oldIndex + 1) return this.toNative(id, false);
        oldParent.children!.splice(oldIndex, 1);
        if (index > oldIndex) index--;
      } else {
        // Firefox: `index` is the final position.
        index = clamp(index, 0, len - 1);
        oldParent.children!.splice(oldIndex, 1);
      }
      oldParent.children!.splice(index, 0, id);
    } else {
      oldParent.children!.splice(oldIndex, 1);
      const index = clamp(destination.index ?? newParent.children!.length, 0, newParent.children!.length);
      newParent.children!.splice(index, 0, id);
      n.parentId = newParent.id;
    }
    this.onMoved.dispatch(id, { parentId: newParent.id, index: newParent.children!.indexOf(id), oldParentId: oldParent.id, oldIndex });
    return this.toNative(id, false);
  }

  async remove(id: string): Promise<void> {
    this.countWrite();
    const n = this.must(id);
    if (this.isRoot(n)) throw new Error("Can't remove the root bookmark folders.");
    this.assertWritable(n, 'remove');
    if (n.children && n.children.length > 0) {
      throw new Error(this.flavor === 'chromium' ? "Can't remove non-empty folder (use recursive to force)." : 'Cannot remove a non-empty folder');
    }
    const parent = this.mustFolder(n.parentId!);
    const index = parent.children!.indexOf(id);
    parent.children!.splice(index, 1);
    this.nodes.delete(id);
    this.onRemoved.dispatch(id, { parentId: parent.id, index, node: { id, title: n.title } });
  }

  // ---- test helpers --------------------------------------------------------

  /** Ids of the browser's permanent folders by role. */
  roots(): { toolbar: string; other: string; mobile: string; menu?: string } {
    return this.flavor === 'chromium'
      ? { toolbar: '1', other: '2', mobile: '3' }
      : { toolbar: 'toolbar_____', other: 'unfiled_____', mobile: 'mobile______', menu: 'menu________' };
  }

  /** Adds a bookmark directly (fires onCreated like a user action). */
  addBookmark(parentId: string, title: string, url: string, index?: number): Promise<NativeNode> {
    return this.create({ parentId, title, url, ...(index !== undefined ? { index } : {}) });
  }

  addFolder(parentId: string, title: string, index?: number): Promise<NativeNode> {
    return this.create({ parentId, title, ...(index !== undefined ? { index } : {}) });
  }

  childIds(id: string): string[] {
    return [...(this.must(id).children ?? [])];
  }

  node(id: string): NativeNode | undefined {
    return this.nodes.has(id) ? this.toNative(id, false) : undefined;
  }

  findByTitle(title: string): NativeNode | undefined {
    for (const n of this.nodes.values()) if (n.title === title) return this.toNative(n.id, false);
    return undefined;
  }

  /** Indented dump of the whole tree, for readable assertions. */
  dump(id = this.rootId, depth = 0): string {
    const n = this.must(id);
    const line = `${'  '.repeat(depth)}${n.type === 'folder' ? '+' : n.type === 'separator' ? '|' : '-'} ${n.title}${n.url && n.type === 'bookmark' ? ` <${n.url}>` : ''}`;
    return [line, ...(n.children ?? []).map((c) => this.dump(c, depth + 1))].join('\n');
  }

  /** Simulates a native-sync account flag change on a root. */
  setSyncing(id: string, syncing: boolean): void {
    this.must(id).syncing = syncing;
  }

  /** Simulates the browser removing a permanent folder (e.g. account sign-out). */
  dropRoot(id: string): void {
    const parent = this.must(this.rootId);
    parent.children = parent.children!.filter((c) => c !== id);
    this.nodes.delete(id);
  }

  // ---- internals -----------------------------------------------------------

  /** Stores a node; attaching it to its parent is the caller's job. */
  private put(n: Omit<FNode, 'dateAdded'>): void {
    this.nodes.set(n.id, { ...n, dateAdded: this.clock++ });
  }

  /** Constructor helper: stores a node and appends it to its parent. */
  private putChild(n: Omit<FNode, 'dateAdded'>): void {
    this.put(n);
    this.nodes.get(n.parentId!)!.children!.push(n.id);
  }

  private newId(): string {
    const n = this.nextId++;
    return this.flavor === 'chromium' ? String(n) : `ff${String(n).padStart(10, '0')}`;
  }

  private countWrite(): void {
    this.writes++;
    if (this.failOnWrite !== null && --this.failOnWrite === 0) {
      this.failOnWrite = null;
      throw new Error('simulated browser failure');
    }
  }

  private must(id: string): FNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(this.flavor === 'chromium' ? "Can't find bookmark for id." : `Bookmark not found: ${id}`);
    return n;
  }

  private mustFolder(id: string): FNode {
    const n = this.must(id);
    if (n.type !== 'folder') throw new Error("Can't find parent bookmark for id.");
    return n;
  }

  private isRoot(n: FNode): boolean {
    return n.id === this.rootId || n.parentId === this.rootId;
  }

  private assertWritable(n: FNode, what: string): void {
    if (n.unmodifiable) throw new Error(`Can't ${what} managed bookmarks.`);
  }

  /**
   * Both browsers normalize URLs on save, with small differences. Chromium
   * keeps an empty fragment ("#"); this fake's Firefox drops it, so the two
   * disagree the way real browsers sometimes do.
   */
  private canonicalize(raw: string): string {
    if (this.flavor === 'firefox' && PRIVILEGED.test(raw.trim())) {
      throw new Error(`Type error for parameter createDetails (Error processing url: Error: Illegal URL: ${raw})`);
    }
    let href: string;
    try {
      href = new URL(raw.trim()).href;
    } catch {
      throw new Error(this.flavor === 'chromium' ? 'Invalid URL.' : `Error processing url: Invalid URL: ${raw}`);
    }
    return this.flavor === 'firefox' && href.endsWith('#') ? href.slice(0, -1) : href;
  }

  private toNative(id: string, deep: boolean): NativeNode {
    const n = this.must(id);
    const parent = n.parentId ? this.nodes.get(n.parentId) : undefined;
    const out: NativeNode = {
      id: n.id,
      title: n.title,
      ...(n.parentId !== undefined ? { parentId: n.parentId, index: parent?.children?.indexOf(n.id) ?? 0 } : {}),
      ...(n.url !== undefined ? { url: n.url } : {}),
      ...(n.folderType !== undefined ? { folderType: n.folderType } : {}),
      ...(n.syncing !== undefined ? { syncing: n.syncing } : {}),
      ...(n.unmodifiable !== undefined ? { unmodifiable: n.unmodifiable } : {}),
      ...(this.flavor === 'firefox' ? { type: n.type } : {}),
    };
    if (deep && n.children) out.children = n.children.map((c) => this.toNative(c, true));
    return out;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
