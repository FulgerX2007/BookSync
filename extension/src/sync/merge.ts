// Three-way merge of bookmark trees: base (last synced), local (this
// browser now) and remote (the server's current vault). The rules are those
// of the merge table in docs/protocol.md §4.4:
//
//  * a change made on one side only wins;
//  * an edit beats a delete (edit = title, url or parent change);
//  * on a true conflict the remote side (already committed) wins;
//  * children of a deleted folder that survive move to the nearest
//    surviving ancestor (walking the parent chain of the side that kept them);
//  * cycles created by crossing moves are broken with the remote parent;
//  * roots are never added, removed, moved or renamed.
//
// The function is pure and deterministic, so retries and repeated merges
// converge.
import {
  ROOT_GUIDS,
  ROOT_OTHER,
  VAULT_FORMAT,
  isRoot,
  parentsOf,
  rootTitle,
  type Guid,
  type VNode,
  type VaultDoc,
} from '../model/vault';

export interface Changes {
  adds: number;
  updates: number;
  moves: number;
  deletes: number;
}

export interface MergeStats {
  /** What applying the result does to this browser. */
  toLocal: Changes;
  /** What uploading the result does to the server's tree. */
  toRemote: Changes;
  /** True conflicts resolved in favour of the remote side. */
  conflicts: number;
}

export interface MergeResult {
  doc: VaultDoc;
  stats: MergeStats;
}

type Side = 'local' | 'remote';

interface Decision {
  node: VNode;
  parent: Guid | undefined;
  /** Whose parent chain to walk if the parent does not survive. */
  side: Side;
}

export function merge3(base: VaultDoc, local: VaultDoc, remote: VaultDoc): MergeResult {
  const pB = parentsOf(base);
  const pL = parentsOf(local);
  const pR = parentsOf(remote);
  let conflicts = 0;

  /** Three-way choice of one value; counts true conflicts. */
  function pick<T>(hasBase: boolean, b: T | undefined, l: T, r: T): T {
    if (l === r) return l;
    if (hasBase && l === b) return r;
    if (hasBase && r === b) return l;
    conflicts++;
    return r;
  }

  const edited = (n: VNode, parent: Guid | undefined, b: VNode, bParent: Guid | undefined) =>
    n.title !== b.title || n.url !== b.url || parent !== bParent;

  // 1. Decide which nodes survive, with which fields and parent.
  const decisions = new Map<Guid, Decision>();
  const guids = [...new Set([...Object.keys(base.nodes), ...Object.keys(local.nodes), ...Object.keys(remote.nodes)])].sort();
  for (const g of guids) {
    if (isRoot(g)) continue;
    const b = base.nodes[g];
    const l = local.nodes[g];
    const r = remote.nodes[g];

    if (l && r) {
      if (l.kind !== r.kind) {
        conflicts++;
        decisions.set(g, { node: fields(r), parent: pR.get(g), side: 'remote' });
        continue;
      }
      const hasBase = b !== undefined && b.kind === l.kind;
      const node: VNode = { guid: g, kind: l.kind, title: pick(hasBase, b?.title, l.title, r.title) };
      if (l.kind === 'bookmark') node.url = pick(hasBase, b?.url, l.url, r.url);
      const lp = pL.get(g);
      const rp = pR.get(g);
      const bp = hasBase ? pB.get(g) : undefined;
      let parent: Guid | undefined;
      let side: Side;
      if (lp === rp) [parent, side] = [rp, 'remote'];
      else if (hasBase && lp === bp) [parent, side] = [rp, 'remote'];
      else if (hasBase && rp === bp) [parent, side] = [lp, 'local'];
      else {
        conflicts++;
        [parent, side] = [rp, 'remote'];
      }
      decisions.set(g, { node, parent, side });
    } else if (l) {
      // Absent remotely: a local add, or a remote delete that a local edit overrides.
      if (!b || edited(l, pL.get(g), b, pB.get(g))) decisions.set(g, { node: fields(l), parent: pL.get(g), side: 'local' });
    } else if (r) {
      if (!b || edited(r, pR.get(g), b, pB.get(g))) decisions.set(g, { node: fields(r), parent: pR.get(g), side: 'remote' });
    }
    // Absent on both sides: deleted (or never synced) — drop.
  }

  const isFolder = (g: Guid | undefined): g is Guid =>
    g !== undefined && (isRoot(g) || decisions.get(g)?.node.kind === 'folder');

  // 2. Re-home nodes whose parent did not survive.
  for (const d of decisions.values()) {
    if (isFolder(d.parent)) continue;
    const chains = d.side === 'local' ? [pL, pR, pB] : [pR, pL, pB];
    d.parent = nearestSurvivor(d.parent, chains, isFolder);
  }

  // 3. Break cycles created by crossing moves.
  repairCycles(decisions, pR, isFolder);

  // 4. Order each folder's children.
  const members = new Map<Guid, Set<Guid>>();
  for (const [g, d] of decisions) {
    let set = members.get(d.parent!);
    if (!set) members.set(d.parent!, (set = new Set()));
    set.add(g);
  }

  const nodes: Record<Guid, VNode> = {};
  for (const root of ROOT_GUIDS) nodes[root] = { guid: root, kind: 'folder', title: rootTitle(root), children: [] };
  for (const [g, d] of decisions) nodes[g] = { ...d.node, ...(d.node.kind === 'folder' ? { children: [] } : {}) };
  for (const [folder, set] of members) {
    nodes[folder]!.children = orderChildren(
      set,
      base.nodes[folder]?.children ?? [],
      local.nodes[folder]?.children,
      remote.nodes[folder]?.children,
    );
  }

  const doc: VaultDoc = { format: VAULT_FORMAT, seq: remote.seq, writtenBy: remote.writtenBy, writtenAt: remote.writtenAt, nodes };
  return { doc, stats: { toLocal: diffStats(local, doc), toRemote: diffStats(remote, doc), conflicts } };
}

/** The node's own fields, without children (rebuilt from parents). */
function fields(n: VNode): VNode {
  return n.kind === 'bookmark' ? { guid: n.guid, kind: 'bookmark', title: n.title, url: n.url ?? '' } : { guid: n.guid, kind: 'folder', title: n.title };
}

/** Walks up from start (a deleted folder) to the first ancestor that survives. */
function nearestSurvivor(start: Guid | undefined, chains: Map<Guid, Guid>[], survives: (g: Guid | undefined) => boolean): Guid {
  const seen = new Set<Guid>();
  let g = start;
  while (g !== undefined && !survives(g) && !seen.has(g)) {
    seen.add(g);
    const from: Guid = g;
    g = chains.map((c) => c.get(from)).find((p) => p !== undefined);
  }
  return survives(g) ? g! : ROOT_OTHER;
}

/**
 * Finds nodes whose parent chain loops and re-parents them: first to their
 * remote parent, and if that still loops (or was already tried), to Other
 * Bookmarks. Processes nodes in guid order for determinism.
 */
function repairCycles(decisions: Map<Guid, Decision>, pR: Map<Guid, Guid>, isFolder: (g: Guid | undefined) => boolean): void {
  const tried = new Set<Guid>();
  for (;;) {
    const cycle = findCycle(decisions);
    if (!cycle) return;
    const g = cycle.reduce((a, b) => (a < b ? a : b));
    const d = decisions.get(g)!;
    const rp = pR.get(g);
    if (!tried.has(g) && rp !== undefined && rp !== d.parent && isFolder(rp)) {
      tried.add(g);
      d.parent = rp;
    } else {
      d.parent = ROOT_OTHER;
    }
  }
}

function findCycle(decisions: Map<Guid, Decision>): Guid[] | undefined {
  const done = new Set<Guid>(); // known to reach a root
  for (const start of [...decisions.keys()].sort()) {
    const path: Guid[] = [];
    const onPath = new Set<Guid>();
    let g: Guid | undefined = start;
    while (g !== undefined && !isRoot(g) && !done.has(g)) {
      if (onPath.has(g)) return path.slice(path.indexOf(g));
      onPath.add(g);
      path.push(g);
      g = decisions.get(g)?.parent;
    }
    for (const p of path) done.add(p);
  }
  return undefined;
}

/** Whether side's order of the children it shares with base differs from base's. */
function reordered(side: readonly Guid[], base: readonly Guid[]): boolean {
  const inSide = new Set(side);
  const inBase = new Set(base);
  const a = side.filter((g) => inBase.has(g));
  const b = base.filter((g) => inSide.has(g));
  return a.some((g, i) => g !== b[i]);
}

/**
 * Orders a folder's final members. The authoritative order is local's if
 * only local reordered, otherwise remote's. Members missing from it are
 * inserted next to their neighbours in the order they came from; anything
 * left (re-homed orphans) is appended in guid order.
 */
function orderChildren(members: Set<Guid>, base: readonly Guid[], local: readonly Guid[] | undefined, remote: readonly Guid[] | undefined): Guid[] {
  let auth: readonly Guid[];
  let other: readonly Guid[] | undefined;
  if (!remote) [auth, other] = [local ?? [], undefined];
  else if (!local) [auth, other] = [remote, undefined];
  else if (reordered(local, base) && !reordered(remote, base)) [auth, other] = [local, remote];
  else [auth, other] = [remote, local];

  const result: Guid[] = [];
  const placed = new Set<Guid>();
  for (const g of auth) {
    if (members.has(g) && !placed.has(g)) {
      result.push(g);
      placed.add(g);
    }
  }
  for (const order of [other, base]) {
    if (!order) continue;
    order.forEach((g, i) => {
      if (!members.has(g) || placed.has(g)) return;
      result.splice(insertionIndex(result, order, i), 0, g);
      placed.add(g);
    });
  }
  for (const g of [...members].sort()) {
    if (!placed.has(g)) result.push(g);
  }
  return result;
}

/** Position after the nearest earlier neighbour in `order` already placed, else before the nearest later one, else at the end. */
function insertionIndex(result: Guid[], order: readonly Guid[], i: number): number {
  for (let j = i - 1; j >= 0; j--) {
    const k = result.indexOf(order[j]!);
    if (k >= 0) return k + 1;
  }
  for (let j = i + 1; j < order.length; j++) {
    const k = result.indexOf(order[j]!);
    if (k >= 0) return k;
  }
  return result.length;
}

/** Counts the changes that turn `from` into `to`. */
export function diffStats(from: VaultDoc, to: VaultDoc): Changes {
  const c: Changes = { adds: 0, updates: 0, moves: 0, deletes: 0 };
  const pFrom = parentsOf(from);
  const pTo = parentsOf(to);
  for (const [g, n] of Object.entries(to.nodes)) {
    if (isRoot(g)) continue;
    const o = from.nodes[g];
    if (!o) {
      c.adds++;
      continue;
    }
    if (o.title !== n.title || o.url !== n.url) c.updates++;
    if (pFrom.get(g) !== pTo.get(g)) c.moves++;
  }
  for (const g of Object.keys(from.nodes)) {
    if (!isRoot(g) && !to.nodes[g]) c.deletes++;
  }
  return c;
}
