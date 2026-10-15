// What a click selects in the manager: a plain click selects one row,
// Ctrl/Cmd toggles a row, Shift selects the range from the anchor (the last
// plain or Ctrl click) in visible order; Ctrl+Shift adds that range.

export interface Selection {
  readonly selected: ReadonlySet<string>;
  /** Where the next Shift range starts. */
  readonly anchor: string | null;
}

export const emptySelection: Selection = { selected: new Set(), anchor: null };

export interface Modifiers {
  ctrl?: boolean;
  shift?: boolean;
}

export function select(state: Selection, id: string, { ctrl = false, shift = false }: Modifiers, visible: readonly string[]): Selection {
  if (shift && state.anchor !== null) {
    const from = visible.indexOf(state.anchor);
    const to = visible.indexOf(id);
    if (from >= 0 && to >= 0) {
      const range = visible.slice(Math.min(from, to), Math.max(from, to) + 1);
      return { selected: new Set(ctrl ? [...state.selected, ...range] : range), anchor: state.anchor };
    }
  }
  if (ctrl) {
    const selected = new Set(state.selected);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    return { selected, anchor: id };
  }
  return { selected: new Set([id]), anchor: id };
}

/** Forgets rows that no longer exist (after a refresh). */
export function pruneSelection(state: Selection, exists: (id: string) => boolean): Selection {
  const selected = new Set([...state.selected].filter(exists));
  const anchor = state.anchor !== null && exists(state.anchor) ? state.anchor : null;
  return selected.size === state.selected.size && anchor === state.anchor ? state : { selected, anchor };
}
