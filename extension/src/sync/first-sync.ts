// First sync of a browser that has no sync base yet: bootstrapping a new
// account, joining an existing one, or re-joining after roots changed.
//
// Local nodes are matched to remote nodes by GUID first (a device that was
// a member before keeps its GUIDs), then by content, top-down within matched
// folders: folders by title, bookmarks by normalized URL with the title as
// tie-breaker. The result is the remote tree plus the unmatched local nodes,
// so a first sync never deletes or renames anything on the account. The
// joining browser adopts the account's titles and order for matched items.
import { ROOT_GUIDS, isRoot, newGuid, parentsOf, type Guid, type VNode, type VaultDoc } from '../model/vault';
import { matchKey } from '../model/url';

export interface FirstSyncResult {
  doc: VaultDoc;
  /** Local guid → remote guid, for local nodes matched to a different guid. */
  guidRemap: Map<Guid, Guid>;
}

export function firstSync(local: VaultDoc, remote: VaultDoc | null): FirstSyncResult {
  if (remote === null) return { doc: structuredClone(local), guidRemap: new Map() };

  const doc = structuredClone(remote);
  /** local guid → guid in the result (matched remote guid, or the local guid if added). */
  const mapped = new Map<Guid, Guid>();
  const matchedRemote = new Set<Guid>();
  for (const root of ROOT_GUIDS) {
    mapped.set(root, root);
    matchedRemote.add(root);
  }

  // 1. GUID matches.
  for (const [g, l] of Object.entries(local.nodes)) {
    if (isRoot(g)) continue;
    const r = remote.nodes[g];
    if (r && r.kind === l.kind) {
      mapped.set(g, g);
      matchedRemote.add(g);
    }
  }

  // 2. Content matches, top-down within matched folder pairs.
  const matchFolder = (lf: Guid, rf: Guid) => {
    const rKids = remote.nodes[rf]?.children ?? [];
    for (const c of local.nodes[lf]?.children ?? []) {
      if (mapped.has(c)) continue;
      const ln = local.nodes[c]!;
      const candidates = rKids.filter((rk) => !matchedRemote.has(rk) && remote.nodes[rk]!.kind === ln.kind);
      const match = ln.kind === 'folder' ? candidates.find((rk) => remote.nodes[rk]!.title === ln.title) : bestBookmark(ln, candidates, remote);
      if (match !== undefined) {
        mapped.set(c, match);
        matchedRemote.add(match);
      }
    }
    for (const c of local.nodes[lf]?.children ?? []) {
      const m = mapped.get(c);
      if (m !== undefined && local.nodes[c]!.kind === 'folder') matchFolder(c, m);
    }
  };
  for (const root of ROOT_GUIDS) matchFolder(root, root);

  // 3. Add unmatched local nodes, parents before children, next to their local neighbours.
  const lParents = parentsOf(local);
  const guidRemap = new Map<Guid, Guid>();
  const visit = (lf: Guid) => {
    const kids = local.nodes[lf]?.children ?? [];
    kids.forEach((c, i) => {
      if (!mapped.has(c)) {
        // The same guid may exist remotely as the other kind: give the local node a fresh one.
        const g = doc.nodes[c] ? newGuid() : c;
        if (g !== c) guidRemap.set(c, g);
        mapped.set(c, g);
        const ln = local.nodes[c]!;
        doc.nodes[g] = ln.kind === 'folder' ? { guid: g, kind: 'folder', title: ln.title, children: [] } : { guid: g, kind: 'bookmark', title: ln.title, url: ln.url ?? '' };
        const parent = doc.nodes[mapped.get(lParents.get(c)!)!]!;
        parent.children!.splice(insertionIndex(parent.children!, kids, i, mapped), 0, g);
      }
      if (local.nodes[c]!.kind === 'folder') visit(c);
    });
  };
  for (const root of ROOT_GUIDS) visit(root);

  for (const [l, r] of mapped) if (l !== r && !guidRemap.has(l)) guidRemap.set(l, r);
  return { doc, guidRemap };
}

/** Same normalized URL; among several, prefer the one with the same title, then the first. */
function bestBookmark(ln: VNode, candidates: Guid[], remote: VaultDoc): Guid | undefined {
  const key = matchKey(ln.url ?? '');
  const sameUrl = candidates.filter((rk) => matchKey(remote.nodes[rk]!.url ?? '') === key);
  return sameUrl.find((rk) => remote.nodes[rk]!.title === ln.title) ?? sameUrl[0];
}

/** After the nearest earlier local sibling already in the target folder, else before the nearest later one, else at the end. */
function insertionIndex(target: Guid[], localKids: readonly Guid[], i: number, mapped: Map<Guid, Guid>): number {
  for (let j = i - 1; j >= 0; j--) {
    const k = target.indexOf(mapped.get(localKids[j]!) ?? '');
    if (k >= 0) return k + 1;
  }
  for (let j = i + 1; j < localKids.length; j++) {
    const k = target.indexOf(mapped.get(localKids[j]!) ?? '');
    if (k >= 0) return k;
  }
  return target.length;
}
