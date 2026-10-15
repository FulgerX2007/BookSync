// Read-only helpers over the adapter's LocalTree, shared by the popup and the
// bookmark manager. The UI keeps no copy of its own: it re-reads the browser
// through the adapter and derives everything here.
import { SYNCED_ROOTS, type LocalTree } from '../browser/adapter';

/** Roots present in this browser, in canonical order: toolbar, menu, other, mobile. */
export function rootIds(t: LocalTree): string[] {
  return SYNCED_ROOTS.map((r) => t.roots[r]).filter((id): id is string => id !== undefined && t.nodes.has(id));
}

/** Root folders have no parent in the LocalTree (the Chromium menu folder included). */
export function isRootId(t: LocalTree, id: string): boolean {
  return t.nodes.get(id)?.parentId === '';
}

/** Titles of the folders above a node, root first; [] for roots and unknown ids. */
export function pathOf(t: LocalTree, id: string): string[] {
  const out: string[] = [];
  for (let p = t.nodes.get(id)?.parentId; p; p = t.nodes.get(p)?.parentId) {
    const n = t.nodes.get(p);
    if (!n) break;
    out.unshift(n.title);
  }
  return out;
}

/** Whether a is b or one of b's ancestors. */
export function isAncestor(t: LocalTree, a: string, b: string): boolean {
  if (!t.nodes.has(b)) return false;
  for (let x: string | undefined = b; x; x = t.nodes.get(x)?.parentId) {
    if (x === a) return true;
  }
  return false;
}

/** Every node, depth-first, roots in canonical order. */
export function treeOrder(t: LocalTree): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    for (const c of t.nodes.get(id)?.children ?? []) walk(c);
  };
  rootIds(t).forEach(walk);
  return out;
}

/** The rows a tree view shows top to bottom: roots always, children of expanded folders. */
export function visibleOrder(t: LocalTree, expanded: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    if (expanded.has(id)) for (const c of t.nodes.get(id)?.children ?? []) walk(c);
  };
  rootIds(t).forEach(walk);
  return out;
}

/**
 * The nodes an action on `ids` really touches: known, not roots, not inside
 * another selected node (moving or deleting a folder covers its contents),
 * deduplicated and in tree order, so moves keep the items' relative order.
 */
export function normalizeSelection(t: LocalTree, ids: Iterable<string>): string[] {
  const wanted = new Set([...ids].filter((id) => t.nodes.has(id) && !isRootId(t, id)));
  const order = treeOrder(t);
  return order.filter((id) => {
    if (!wanted.has(id)) return false;
    for (let p = t.nodes.get(id)?.parentId; p; p = t.nodes.get(p)?.parentId) {
      if (wanted.has(p)) return false;
    }
    return true;
  });
}

export interface FolderOption {
  id: string;
  title: string;
  depth: number;
  /** Title indented by depth, for a plain <select>. */
  label: string;
}

/** Every folder, roots included, in tree order. */
export function folderOptions(t: LocalTree): FolderOption[] {
  const out: FolderOption[] = [];
  const walk = (id: string, depth: number) => {
    const n = t.nodes.get(id);
    if (n?.kind !== 'folder') return;
    const title = n.title || 'Untitled folder';
    out.push({ id, title, depth, label: '  '.repeat(depth) + title });
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  for (const r of rootIds(t)) walk(r, 0);
  return out;
}

/** How many bookmarks and folders an action on `ids` touches, contents included. */
export function countSubtree(t: LocalTree, ids: Iterable<string>): { bookmarks: number; folders: number } {
  let bookmarks = 0;
  let folders = 0;
  const walk = (id: string) => {
    const n = t.nodes.get(id);
    if (!n) return;
    if (n.kind === 'bookmark') bookmarks++;
    else folders++;
    for (const c of n.children ?? []) walk(c);
  };
  normalizeSelection(t, ids).forEach(walk);
  return { bookmarks, folders };
}
