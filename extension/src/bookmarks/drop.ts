// Where a drag-and-drop lands in the manager. The UI turns the pointer
// position into a zone of the target row; resolveDrop turns zone + target
// into the anchor-based move that ops.moveMany performs, or refuses it.
import type { LocalTree } from '../browser/adapter';
import { isAncestor, isRootId, normalizeSelection } from './tree';

export type Zone = 'before' | 'after' | 'inside';

export type DropResult = { parentId: string; afterId: string | null } | { noop: true } | { refused: string };

/**
 * The zone under the pointer: folders split into top quarter (before),
 * middle (inside) and bottom quarter (after); bookmarks into halves.
 */
export function zoneAt(offsetY: number, height: number, isFolder: boolean): Zone {
  const f = height > 0 ? offsetY / height : 0.5;
  if (!isFolder) return f < 0.5 ? 'before' : 'after';
  if (f < 0.25) return 'before';
  if (f >= 0.75) return 'after';
  return 'inside';
}

/** The closest sibling before `id` (or before and including it) that is not being moved. */
function anchorBefore(siblings: readonly string[], id: string, moving: ReadonlySet<string>, inclusive: boolean): string | null {
  for (let i = siblings.indexOf(id) - (inclusive ? 0 : 1); i >= 0; i--) {
    if (!moving.has(siblings[i]!)) return siblings[i]!;
  }
  return null;
}

/**
 * Rules, in order: roots are never dragged; "after" an expanded folder means
 * its first child (an expanded root too, even an empty one); other drops
 * beside a root are refused; "inside" appends; before/after skip over the
 * dragged nodes themselves; nothing lands in a dragged folder; a drop that
 * changes nothing is a no-op.
 */
export function resolveDrop(tree: LocalTree, dragged: readonly string[], targetId: string, zone: Zone, expanded: ReadonlySet<string>): DropResult {
  if (dragged.some((id) => isRootId(tree, id))) return { refused: 'Root folders cannot be moved.' };
  const list = normalizeSelection(tree, dragged);
  if (list.length === 0) return { refused: 'Nothing to move.' };
  const target = tree.nodes.get(targetId);
  if (!target) return { refused: 'That item is gone.' };
  const moving = new Set(list);

  let parentId: string;
  let afterId: string | null;
  const children = target.children ?? [];
  const targetIsRoot = isRootId(tree, targetId);
  if (zone === 'after' && target.kind === 'folder' && expanded.has(targetId) && (children.length > 0 || targetIsRoot)) {
    parentId = targetId;
    afterId = null;
  } else if (targetIsRoot && zone !== 'inside') {
    return { refused: 'Drop inside a root folder, not next to it.' };
  } else if (zone === 'inside') {
    if (target.kind !== 'folder') return { refused: 'Only folders can hold bookmarks.' };
    parentId = targetId;
    afterId = children.length > 0 ? anchorBefore(children, children.at(-1)!, moving, true) : null;
  } else {
    parentId = target.parentId;
    const siblings = tree.nodes.get(parentId)?.children ?? [];
    afterId = anchorBefore(siblings, targetId, moving, zone === 'after');
  }

  if (list.some((m) => isAncestor(tree, m, parentId))) return { refused: 'A folder cannot be moved into itself.' };

  const kids = tree.nodes.get(parentId)?.children ?? [];
  const rest = kids.filter((k) => !moving.has(k));
  const at = afterId === null ? 0 : rest.indexOf(afterId) + 1;
  const result = [...rest.slice(0, at), ...list, ...rest.slice(at)];
  if (result.length === kids.length && result.every((k, i) => k === kids[i])) return { noop: true };
  return { parentId, afterId };
}
