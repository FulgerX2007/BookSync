// fast-check generators for random bookmark trees and random edit scripts.
import fc from 'fast-check';
import { emptyDoc, isRoot, parentsOf, type Guid, type VaultDoc } from '../src/model/vault';

// Picks are raw numbers, reduced modulo the candidate count when applied, so
// any generated script is valid against any tree.
export type Edit =
  | { op: 'addBookmark'; parent: number; index: number; title: number; url: number }
  | { op: 'addFolder'; parent: number; index: number; title: number }
  | { op: 'rename'; target: number; title: number }
  | { op: 'reurl'; target: number; url: number }
  | { op: 'move'; target: number; parent: number; index: number }
  | { op: 'delete'; target: number };

const pick = fc.nat(1000);
// Small value domains make collisions (same title/url on both sides) likely.
const smallTitle = fc.nat(5);
const smallUrl = fc.nat(5);

export const arbEdit: fc.Arbitrary<Edit> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ op: fc.constant('addBookmark' as const), parent: pick, index: pick, title: smallTitle, url: smallUrl }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('addFolder' as const), parent: pick, index: pick, title: smallTitle }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('rename' as const), target: pick, title: smallTitle }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('reurl' as const), target: pick, url: smallUrl }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('move' as const), target: pick, parent: pick, index: pick }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('delete' as const), target: pick }) },
);

export const arbEdits = (max = 15) => fc.array(arbEdit, { maxLength: max, size: 'medium' });

/** A random valid tree, built by applying random additions to an empty doc. */
export const arbTree: fc.Arbitrary<VaultDoc> = fc
  .array(fc.oneof(arbEdit.filter((e) => e.op === 'addBookmark' || e.op === 'addFolder')), { maxLength: 40, size: 'medium' })
  .map((edits) => applyEdits(emptyDoc(), edits, 'b'));

function folders(d: VaultDoc): Guid[] {
  return Object.keys(d.nodes)
    .filter((g) => d.nodes[g]!.kind === 'folder')
    .sort();
}

function nonRoots(d: VaultDoc): Guid[] {
  return Object.keys(d.nodes)
    .filter((g) => !isRoot(g))
    .sort();
}

function isDescendant(d: VaultDoc, node: Guid, maybeAncestor: Guid): boolean {
  const parents = parentsOf(d);
  for (let g: Guid | undefined = node; g !== undefined; g = parents.get(g)) if (g === maybeAncestor) return true;
  return false;
}

function detach(d: VaultDoc, g: Guid): void {
  const parent = parentsOf(d).get(g);
  if (parent) d.nodes[parent]!.children = d.nodes[parent]!.children!.filter((c) => c !== g);
}

function insert(d: VaultDoc, parent: Guid, g: Guid, index: number): void {
  const kids = d.nodes[parent]!.children!;
  kids.splice(index % (kids.length + 1), 0, g);
}

function removeSubtree(d: VaultDoc, g: Guid): void {
  for (const c of d.nodes[g]?.children ?? []) removeSubtree(d, c);
  delete d.nodes[g];
}

/**
 * Applies edits to a copy of doc. New nodes get guids `${prefix}1`,
 * `${prefix}2`, ... so two sides editing the same base never collide.
 */
export function applyEdits(doc: VaultDoc, edits: readonly Edit[], prefix: string): VaultDoc {
  const d = structuredClone(doc);
  let next = 1;
  for (const e of edits) {
    switch (e.op) {
      case 'addBookmark':
      case 'addFolder': {
        const fs = folders(d);
        const parent = fs[e.parent % fs.length]!;
        const g = `${prefix}${next++}`;
        d.nodes[g] =
          e.op === 'addBookmark'
            ? { guid: g, kind: 'bookmark', title: `t${e.title}`, url: `https://u${e.url}.example/` }
            : { guid: g, kind: 'folder', title: `t${e.title}`, children: [] };
        insert(d, parent, g, e.index);
        break;
      }
      case 'rename':
      case 'reurl':
      case 'move':
      case 'delete': {
        const ns = nonRoots(d);
        if (ns.length === 0) break;
        const g = ns[e.target % ns.length]!;
        const node = d.nodes[g]!;
        if (e.op === 'rename') node.title = `t${e.title}`;
        else if (e.op === 'reurl') {
          if (node.kind === 'bookmark') node.url = `https://u${e.url}.example/`;
        } else if (e.op === 'delete') {
          detach(d, g);
          removeSubtree(d, g);
        } else {
          const candidates = folders(d).filter((f) => !isDescendant(d, f, g));
          const parent = candidates[e.parent % candidates.length]!;
          detach(d, g);
          insert(d, parent, g, e.index);
        }
        break;
      }
    }
  }
  return d;
}

