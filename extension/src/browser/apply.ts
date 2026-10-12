// Applies a merged VaultDoc to the browser.
//
// planOps() diffs the browser's projection against the merged tree:
//   1. structure, folder by folder top-down: creates and moves in the
//      folder's merged order. The nodes on a longest increasing subsequence
//      of current positions stay put, so moves are minimal;
//   2. title/url updates;
//   3. removals, children before parents.
// applyOps() executes them, persisting every id-map binding as soon as its
// browser call resolves, so an interrupted apply never loses track of what
// it created.
import { ROOT_GUIDS, isRoot, parentsOf, type Guid, type VNode, type VaultDoc } from '../model/vault';
import { matchKey } from '../model/url';
import type { IdMap, IdMapEntry, RootPins } from '../storage/state';
import { BookmarkRejectedError, NonEmptyFolderError, type BookmarksAdapter, type LocalTree } from './adapter';

export type Op =
  | { kind: 'create'; guid: Guid; parent: Guid; after: Guid[]; node: VNode }
  | { kind: 'move'; guid: Guid; parent: Guid; after: Guid[] }
  | { kind: 'update'; guid: Guid; title?: string; url?: string }
  | { kind: 'remove'; guid: Guid };

/** The user changed bookmarks while we were applying; restart the sync. */
export class ConcurrentEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentEditError';
  }
}

/**
 * @param local    the browser's projection (may contain virtual nodes carried from base)
 * @param merged   the tree to reach
 * @param hasNativeNode whether a guid has a real browser node
 * @param skipped  guids the browser refused; never re-created
 */
export function planOps(local: VaultDoc, merged: VaultDoc, hasNativeNode: (g: Guid) => boolean, skipped: ReadonlySet<Guid>): Op[] {
  // A browser node always appears in the projection; guard against callers that disagree.
  const isNative = (g: Guid) => local.nodes[g] !== undefined && hasNativeNode(g);
  const structure: Op[] = [];
  const updates: Op[] = [];
  const lParents = parentsOf(local);
  const willExist = (g: Guid) => isNative(g) || !skipped.has(g);

  const visit = (folder: Guid) => {
    const desired = (merged.nodes[folder]?.children ?? []).filter(willExist);
    const current = (local.nodes[folder]?.children ?? []).filter((g) => isNative(g) && !isRoot(g));
    const stable = stableSet(desired, current);
    desired.forEach((g, i) => {
      const after = desired.slice(0, i).reverse();
      if (!isNative(g)) {
        structure.push({ kind: 'create', guid: g, parent: folder, after, node: merged.nodes[g]! });
      } else if (lParents.get(g) !== folder || !stable.has(g)) {
        structure.push({ kind: 'move', guid: g, parent: folder, after });
      }
      if (isNative(g)) {
        const l = local.nodes[g]!;
        const m = merged.nodes[g]!;
        const title = l.title !== m.title ? m.title : undefined;
        const url = m.kind === 'bookmark' && l.url !== m.url ? m.url : undefined;
        if (title !== undefined || url !== undefined) {
          updates.push({ kind: 'update', guid: g, ...(title !== undefined ? { title } : {}), ...(url !== undefined ? { url } : {}) });
        }
      }
    });
    for (const g of desired) if (merged.nodes[g]?.kind === 'folder') visit(g);
  };
  for (const root of ROOT_GUIDS) visit(root);

  // Removals bottom-up: native nodes the merged tree no longer has.
  const removals: Op[] = [];
  const post = (g: Guid) => {
    for (const c of local.nodes[g]?.children ?? []) post(c);
    if (!isRoot(g) && isNative(g) && !merged.nodes[g]) removals.push({ kind: 'remove', guid: g });
  };
  for (const root of ROOT_GUIDS) post(root);

  return [...structure, ...updates, ...removals];
}

/** Desired nodes already in the folder whose relative order can stay (longest increasing subsequence). */
function stableSet(desired: readonly Guid[], current: readonly Guid[]): Set<Guid> {
  const pos = new Map(current.map((g, i) => [g, i]));
  const seq = desired.filter((g) => pos.has(g));
  // Patience sorting LIS over current positions, keeping predecessors.
  const tails: number[] = [];
  const tailIdx: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  seq.forEach((g, i) => {
    const p = pos.get(g)!;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid]! < p) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = p;
    tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1]! : -1;
  });
  const out = new Set<Guid>();
  for (let i = tails.length ? tailIdx[tails.length - 1]! : -1; i >= 0; i = prev[i]!) out.add(seq[i]!);
  return out;
}

export interface ApplyContext {
  adapter: BookmarksAdapter;
  tree: LocalTree;
  idMap: IdMap;
  pins: RootPins;
  skipped: Set<Guid>;
}

export interface ApplyResult {
  pins: RootPins;
  skipped: Set<Guid>;
  /** Browser write calls made. */
  writes: number;
}

/**
 * Executes ops. Refused creates (and updates to a refused URL) mark the guid
 * skipped; a non-empty folder removal raises ConcurrentEditError; any other
 * failure propagates. Either way the id map already reflects every write
 * that happened.
 */
export async function applyOps(ops: readonly Op[], ctx: ApplyContext): Promise<ApplyResult> {
  const { adapter, idMap } = ctx;
  let pins = { ...ctx.pins };
  const skipped = new Set(ctx.skipped);
  const unavailable = new Set<Guid>(); // refused here or under a refused parent
  let writes = 0;

  const folderId = async (g: Guid): Promise<string | undefined> => {
    if (unavailable.has(g)) return undefined;
    if (isRoot(g)) {
      const known = pins[g] ?? ctx.tree.roots[g];
      if (known !== undefined) return known;
      try {
        const r = await adapter.ensureRoot(g, pins);
        pins = r.pins;
        writes++;
        return r.id;
      } catch (e) {
        if (e instanceof BookmarkRejectedError) {
          unavailable.add(g);
          return undefined;
        }
        throw e;
      }
    }
    return idMap.localIdOf(g);
  };
  const anchor = (after: readonly Guid[]): string | null => {
    for (const g of after) {
      if (unavailable.has(g)) continue;
      const id = idMap.localIdOf(g);
      if (id !== undefined) return id;
    }
    return null;
  };

  for (const op of ops) {
    switch (op.kind) {
      case 'create': {
        const parent = await folderId(op.parent);
        if (parent === undefined) {
          unavailable.add(op.guid);
          skipped.add(op.guid);
          break;
        }
        try {
          const props = op.node.kind === 'bookmark' ? { title: op.node.title, url: op.node.url ?? '' } : { title: op.node.title };
          const created = await adapter.create(parent, anchor(op.after), props);
          writes++;
          const entry: IdMapEntry = { localId: created.id, guid: op.guid, ...(created.url !== undefined ? { nativeUrl: created.url } : {}) };
          await idMap.set(entry);
          skipped.delete(op.guid);
        } catch (e) {
          if (!(e instanceof BookmarkRejectedError)) throw e;
          unavailable.add(op.guid);
          skipped.add(op.guid);
        }
        break;
      }
      case 'move': {
        const id = idMap.localIdOf(op.guid);
        const parent = await folderId(op.parent);
        if (id === undefined || parent === undefined) break;
        await adapter.moveAfter(id, parent, anchor(op.after));
        writes++;
        break;
      }
      case 'update': {
        const id = idMap.localIdOf(op.guid);
        if (id === undefined) break;
        try {
          const res = await adapter.update(id, { ...(op.title !== undefined ? { title: op.title } : {}), ...(op.url !== undefined ? { url: op.url } : {}) });
          writes++;
          if (op.url !== undefined) await idMap.set({ localId: id, guid: op.guid, ...(res.url !== undefined ? { nativeUrl: res.url } : {}) });
        } catch (e) {
          if (!(e instanceof BookmarkRejectedError)) throw e;
          // The browser cannot hold the new URL: drop the stale copy and keep the vault's version as skipped.
          await adapter.remove(id);
          writes++;
          await idMap.remove(id);
          skipped.add(op.guid);
        }
        break;
      }
      case 'remove': {
        const id = idMap.localIdOf(op.guid);
        if (id === undefined) break;
        try {
          await adapter.remove(id);
        } catch (e) {
          if (e instanceof NonEmptyFolderError) throw new ConcurrentEditError(`folder ${op.guid} gained children during sync`);
          throw e;
        }
        writes++;
        await idMap.remove(id);
        break;
      }
    }
  }
  return { pins, skipped, writes };
}

/** Drops skipped guids the merged tree no longer contains. */
export function pruneSkipped(skipped: ReadonlySet<Guid>, merged: VaultDoc): Set<Guid> {
  return new Set([...skipped].filter((g) => merged.nodes[g] !== undefined));
}

/**
 * Crash recovery: after an apply was interrupted, browser nodes it created
 * may lack id-map entries. Binds each unbound browser node to the node of
 * `pending` (the merged tree being applied) with the same parent, kind,
 * title and URL that is not bound yet. Top-down, so created folders are
 * bound before their children. Returns the number of nodes rebound.
 */
export async function rebindPending(tree: LocalTree, pending: VaultDoc, idMap: IdMap): Promise<number> {
  let rebound = 0;
  const visit = async (localFolder: string, guidFolder: Guid | undefined) => {
    const kids = tree.nodes.get(localFolder)?.children ?? [];
    for (const c of kids) {
      const n = tree.nodes.get(c)!;
      let g = idMap.guidOf(c);
      if (g === undefined && guidFolder !== undefined) {
        const candidates = pending.nodes[guidFolder]?.children ?? [];
        g = candidates.find((cand) => {
          const m = pending.nodes[cand]!;
          return (
            idMap.localIdOf(cand) === undefined &&
            m.kind === n.kind &&
            m.title === n.title &&
            (n.kind === 'folder' || matchKey(m.url ?? '') === matchKey(n.url ?? ''))
          );
        });
        if (g !== undefined) {
          await idMap.set({ localId: c, guid: g, ...(n.url !== undefined ? { nativeUrl: n.url } : {}) });
          rebound++;
        }
      }
      if (n.kind === 'folder') await visit(c, g);
    }
  };
  for (const root of ROOT_GUIDS) {
    const id = tree.roots[root];
    if (id !== undefined) await visit(id, root);
  }
  return rebound;
}
