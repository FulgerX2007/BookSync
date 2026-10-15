import { describe, expect, it } from 'vitest';
import { emptySelection, pruneSelection, select, type Selection } from './selection';

// Visible rows: root R1 with F/{a, b}, c; root R2 with z.
const visible = ['R1', 'F', 'a', 'b', 'c', 'R2', 'z'];
const sel = (s: Selection) => [...s.selected].sort();

describe('select', () => {
  it('selects one row on a plain click', () => {
    const s = select(select(emptySelection, 'a', {}, visible), 'c', {}, visible);
    expect(sel(s)).toEqual(['c']);
    expect(s.anchor).toBe('c');
  });

  it('toggles rows with Ctrl/Cmd and moves the anchor', () => {
    let s = select(emptySelection, 'a', {}, visible);
    s = select(s, 'c', { ctrl: true }, visible);
    expect(sel(s)).toEqual(['a', 'c']);
    expect(s.anchor).toBe('c');
    s = select(s, 'a', { ctrl: true }, visible);
    expect(sel(s)).toEqual(['c']);
    expect(s.anchor).toBe('a');
  });

  it('selects a range with Shift, down and up, keeping the anchor', () => {
    const start = select(emptySelection, 'a', {}, visible);
    const down = select(start, 'c', { shift: true }, visible);
    expect(sel(down)).toEqual(['a', 'b', 'c']);
    expect(down.anchor).toBe('a');
    const up = select(down, 'R1', { shift: true }, visible);
    expect(sel(up)).toEqual(['F', 'R1', 'a']);
  });

  it('starts a Shift range at the last toggled row', () => {
    let s = select(emptySelection, 'z', {}, visible);
    s = select(s, 'b', { ctrl: true }, visible);
    s = select(s, 'F', { shift: true }, visible);
    expect(sel(s)).toEqual(['F', 'a', 'b']);
  });

  it('adds a range to the selection with Ctrl+Shift', () => {
    let s = select(emptySelection, 'z', {}, visible);
    s = select(s, 'a', { ctrl: true }, visible);
    s = select(s, 'c', { ctrl: true, shift: true }, visible);
    expect(sel(s)).toEqual(['a', 'b', 'c', 'z']);
  });

  it('selects ranges across folder and root boundaries', () => {
    const s = select(select(emptySelection, 'b', {}, visible), 'z', { shift: true }, visible);
    expect(sel(s)).toEqual(['R2', 'b', 'c', 'z']);
  });

  it('treats Shift as a plain click without a usable anchor', () => {
    expect(sel(select(emptySelection, 'b', { shift: true }, visible))).toEqual(['b']);
    const hiddenAnchor: Selection = { selected: new Set(['x']), anchor: 'x' };
    const s = select(hiddenAnchor, 'b', { shift: true }, visible);
    expect(sel(s)).toEqual(['b']);
    expect(s.anchor).toBe('b');
  });
});

describe('pruneSelection', () => {
  it('forgets rows that no longer exist, and the anchor with them', () => {
    const s: Selection = { selected: new Set(['a', 'b', 'gone']), anchor: 'gone' };
    const p = pruneSelection(s, (id) => id !== 'gone');
    expect(sel(p)).toEqual(['a', 'b']);
    expect(p.anchor).toBeNull();
  });

  it('returns the same selection when nothing is gone', () => {
    const s: Selection = { selected: new Set(['a']), anchor: 'a' };
    expect(pruneSelection(s, () => true)).toBe(s);
  });
});
