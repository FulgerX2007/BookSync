// Projects the browser's bookmark tree into a VaultDoc that the merge can
// compare against base and remote.
//
// Besides mapping browser ids to guids, the projection hides everything that
// is not a real local edit:
//  * a root this browser cannot show (Chromium menu folder deleted, a root
//    Firefox lacks) is carried over from base, so it never reads as deleted;
//  * bookmarks the browser refused to create ("skipped") are re-inserted from
//    base at their base position;
//  * a URL the browser rewrote on save reads as the vault URL.
import { ROOT_GUIDS, emptyDoc, newGuid, type Guid, type RootGuid, type VNode, type VaultDoc } from '../model/vault';
import type { IdMap, IdMapEntry } from '../storage/state';
import type { LocalTree } from './adapter';

export interface ProjectionInput {
  tree: LocalTree;
  idMap: IdMap;
  base: VaultDoc | null;
  skipped: ReadonlySet<Guid>;
}

export async function project({ tree, idMap, base, skipped }: ProjectionInput): Promise<VaultDoc> {
  const doc = emptyDoc();
  const fresh: IdMapEntry[] = [];

  const guidFor = (localId: string): Guid => {
    const known = idMap.guidOf(localId);
    if (known !== undefined) return known;
    const g = newGuid();
    fresh.push({ localId, guid: g });
    return g;
  };

  const walk = (localId: string, parentGuid: Guid) => {
    const n = tree.nodes.get(localId);
    if (!n) return;
    const g = guidFor(localId);
    const node: VNode = { guid: g, kind: n.kind, title: n.title };
    if (n.kind === 'bookmark') {
      const nativeUrl = n.url ?? '';
      const vaultUrl = base?.nodes[g]?.url;
      const entry = idMap.entryOf(localId);
      node.url = entry?.nativeUrl !== undefined && entry.nativeUrl === nativeUrl && vaultUrl !== undefined ? vaultUrl : nativeUrl;
    } else {
      node.children = [];
    }
    doc.nodes[g] = node;
    doc.nodes[parentGuid]!.children!.push(g);
    for (const c of n.children ?? []) walk(c, g);
  };

  const absent: RootGuid[] = [];
  for (const root of ROOT_GUIDS) {
    const id = tree.roots[root];
    if (id === undefined) {
      absent.push(root);
      continue;
    }
    for (const c of tree.nodes.get(id)?.children ?? []) walk(c, root);
  }

  await idMap.setMany(fresh);
  // Forget bindings whose browser node is gone (deleted by the user, or now
  // outside the synced roots): otherwise a later removal would target a
  // node that no longer exists.
  await idMap.removeMany(idMap.entries().filter((e) => !tree.nodes.has(e.localId)).map((e) => e.localId));

  if (base) {
    for (const root of absent) carryFromBase(doc, base, root);
    reinsertSkipped(doc, base, skipped);
  }
  return doc;
}

/** Copies base's subtree under `root`, skipping nodes the browser already shows elsewhere. */
function carryFromBase(doc: VaultDoc, base: VaultDoc, root: RootGuid): void {
  const carry = (g: Guid): boolean => {
    const b = base.nodes[g];
    if (!b || doc.nodes[g]) return false;
    doc.nodes[g] = b.kind === 'folder' ? { guid: g, kind: 'folder', title: b.title, children: [] } : { guid: g, kind: 'bookmark', title: b.title, url: b.url ?? '' };
    if (b.kind === 'folder') doc.nodes[g]!.children = (b.children ?? []).filter(carry);
    return true;
  };
  doc.nodes[root]!.children = (base.nodes[root]?.children ?? []).filter(carry);
}

/**
 * Puts skipped nodes back where base had them: after the nearest earlier
 * base sibling the browser still shows, or first. A skipped node whose base
 * parent is gone locally is dropped (the user deleted the folder).
 */
function reinsertSkipped(doc: VaultDoc, base: VaultDoc, skipped: ReadonlySet<Guid>): void {
  if (skipped.size === 0) return;
  const visit = (parent: Guid) => {
    const kids = base.nodes[parent]?.children ?? [];
    kids.forEach((g, i) => {
      if (skipped.has(g) && !doc.nodes[g] && doc.nodes[parent]?.kind === 'folder') {
        const b = base.nodes[g]!;
        doc.nodes[g] = b.kind === 'folder' ? { guid: g, kind: 'folder', title: b.title, children: [] } : { guid: g, kind: 'bookmark', title: b.title, url: b.url ?? '' };
        const target = doc.nodes[parent]!.children!;
        let at = 0;
        for (let j = i - 1; j >= 0; j--) {
          const k = target.indexOf(kids[j]!);
          if (k >= 0) {
            at = k + 1;
            break;
          }
        }
        target.splice(at, 0, g);
      }
      if (base.nodes[g]?.kind === 'folder') visit(g);
    });
  };
  for (const root of ROOT_GUIDS) visit(root);
}
