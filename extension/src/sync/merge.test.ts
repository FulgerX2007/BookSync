import { describe, expect, it } from 'vitest';
import { doc, outline, type Spec } from '../../test/builders';
import { ROOT_OTHER, ROOT_TOOLBAR, validateTree, type VaultDoc } from '../model/vault';
import { merge3 } from './merge';

const T = ROOT_TOOLBAR;
const O = ROOT_OTHER;
const tree = (toolbar: Spec[], other: Spec[] = []) => doc({ [T]: toolbar, [O]: other });

function run(base: VaultDoc, local: VaultDoc, remote: VaultDoc) {
  const res = merge3(base, local, remote);
  expect(validateTree(res.doc)).toEqual([]);
  return res;
}

function expectTree(actual: VaultDoc, expected: VaultDoc) {
  expect(outline(actual)).toBe(outline(expected));
}

describe('merge3', () => {
  it('keeps adds from both sides, local after its predecessor', () => {
    const base = tree([{ b: 'a' }]);
    const { doc: m } = run(base, tree([{ b: 'a' }, { b: 'x' }]), tree([{ b: 'a' }, { b: 'y' }]));
    expectTree(m, tree([{ b: 'a' }, { b: 'x' }, { b: 'y' }]));
  });

  it('takes a change made on one side only', () => {
    const base = tree([{ b: 'a' }, { b: 'c' }]);
    const { doc: m, stats } = run(base, tree([{ b: 'a', title: 'L' }, { b: 'c' }]), tree([{ b: 'a' }, { b: 'c', url: 'https://new/' }]));
    expectTree(m, tree([{ b: 'a', title: 'L' }, { b: 'c', url: 'https://new/' }]));
    expect(stats.conflicts).toBe(0);
  });

  it('accepts an identical change on both sides without conflict', () => {
    const base = tree([{ b: 'a' }]);
    const { doc: m, stats } = run(base, tree([{ b: 'a', title: 'same' }]), tree([{ b: 'a', title: 'same' }]));
    expectTree(m, tree([{ b: 'a', title: 'same' }]));
    expect(stats.conflicts).toBe(0);
  });

  it('lets remote win a true title or url conflict', () => {
    const base = tree([{ b: 'a' }]);
    const { doc: m, stats } = run(
      base,
      tree([{ b: 'a', title: 'L', url: 'https://l/' }]),
      tree([{ b: 'a', title: 'R', url: 'https://r/' }]),
    );
    expectTree(m, tree([{ b: 'a', title: 'R', url: 'https://r/' }]));
    expect(stats.conflicts).toBe(2);
  });

  it('keeps a locally edited node that remote deleted', () => {
    const base = tree([{ b: 'a' }, { b: 'b' }]);
    const { doc: m } = run(base, tree([{ b: 'a', title: 'edited' }, { b: 'b' }]), tree([{ b: 'b' }]));
    expectTree(m, tree([{ b: 'a', title: 'edited' }, { b: 'b' }]));
  });

  it('keeps a remotely edited node that local deleted', () => {
    const base = tree([{ b: 'a' }, { b: 'b' }]);
    const { doc: m } = run(base, tree([{ b: 'b' }]), tree([{ b: 'a', url: 'https://edited/' }, { b: 'b' }]));
    expectTree(m, tree([{ b: 'a', url: 'https://edited/' }, { b: 'b' }]));
  });

  it('deletes a node removed on one side and unchanged on the other', () => {
    const base = tree([{ b: 'a' }, { b: 'b' }]);
    const { doc: m, stats } = run(base, tree([{ b: 'b' }]), base);
    expectTree(m, tree([{ b: 'b' }]));
    expect(stats.toRemote.deletes).toBe(1);
    expect(stats.toLocal.deletes).toBe(0);
  });

  it('deletes on both sides', () => {
    const base = tree([{ b: 'a' }, { b: 'b' }]);
    const { doc: m } = run(base, tree([{ b: 'b' }]), tree([{ b: 'b' }]));
    expectTree(m, tree([{ b: 'b' }]));
  });

  it('treats a reorder as no edit: deleting a folder the other side only re-sorted wins', () => {
    const base = tree([{ f: 'f', children: [{ b: 'x' }, { b: 'y' }] }]);
    const { doc: m } = run(base, tree([]), tree([{ f: 'f', children: [{ b: 'y' }, { b: 'x' }] }]));
    expectTree(m, tree([]));
  });

  it('re-homes a child added to a folder the other side deleted (Dogear rule)', () => {
    const base = tree([{ b: 'a' }, { f: 'f', children: [{ b: 'x' }] }]);
    const local = tree([{ b: 'a' }, { f: 'f', children: [{ b: 'x' }, { b: 'c' }] }]);
    const remote = tree([{ b: 'a' }]);
    const { doc: m } = run(base, local, remote);
    expectTree(m, tree([{ b: 'a' }, { b: 'c' }]));
  });

  it('re-homes an edited child of a deleted folder', () => {
    const base = tree([{ f: 'f', children: [{ b: 'x' }, { b: 'y' }] }]);
    const local = tree([{ f: 'f', children: [{ b: 'x', title: 'kept' }, { b: 'y' }] }]);
    const { doc: m } = run(base, local, tree([]));
    expectTree(m, tree([{ b: 'x', title: 'kept' }]));
  });

  it('re-homes up several levels when ancestors were deleted too', () => {
    const base = tree([{ f: 'f', children: [{ f: 'g', children: [{ b: 'x' }] }] }]);
    const local = tree([{ f: 'f', children: [{ f: 'g', children: [{ b: 'x' }, { b: 'new' }] }] }]);
    const { doc: m } = run(base, local, tree([]));
    expectTree(m, tree([{ b: 'new' }]));
  });

  it('re-homes a node locally moved into a folder remote deleted', () => {
    const base = tree([{ b: 'a' }, { f: 'f' }]);
    const local = tree([{ f: 'f', children: [{ b: 'a' }] }]);
    const { doc: m } = run(base, local, tree([{ b: 'a' }]));
    expectTree(m, tree([{ b: 'a' }]));
  });

  it('keeps a folder edited on one side and deleted on the other, emptied of deleted children', () => {
    const base = tree([{ f: 'f', children: [{ b: 'x' }] }]);
    const remote = tree([{ f: 'f', title: 'renamed', children: [{ b: 'x' }] }]);
    const { doc: m } = run(base, tree([]), remote);
    expectTree(m, tree([{ f: 'f', title: 'renamed' }]));
  });

  it('lets remote win a move/move conflict', () => {
    const base = tree([{ b: 'a' }, { f: 'f' }, { f: 'g' }]);
    const local = tree([{ f: 'f', children: [{ b: 'a' }] }, { f: 'g' }]);
    const remote = tree([{ f: 'f' }, { f: 'g', children: [{ b: 'a' }] }]);
    const { doc: m, stats } = run(base, local, remote);
    expectTree(m, remote);
    expect(stats.conflicts).toBeGreaterThan(0);
  });

  it('breaks a cycle from crossing moves using the remote parent', () => {
    const base = tree([{ f: 'f' }, { f: 'g' }]);
    const local = tree([{ f: 'g', children: [{ f: 'f' }] }]); // f moved into g
    const remote = tree([{ f: 'f', children: [{ f: 'g' }] }]); // g moved into f
    const { doc: m } = run(base, local, remote);
    expectTree(m, remote);
  });

  it('keeps a one-sided reorder and inserts the other side’s new child after its neighbour', () => {
    const base = tree([{ b: 'a' }, { b: 'b' }, { b: 'c' }]);
    const local = tree([{ b: 'c' }, { b: 'a' }, { b: 'b' }]);
    const remote = tree([{ b: 'a' }, { b: 'b' }, { b: 'd' }, { b: 'c' }]);
    const { doc: m } = run(base, local, remote);
    expectTree(m, tree([{ b: 'c' }, { b: 'a' }, { b: 'b' }, { b: 'd' }]));
  });

  it('takes the remote order when both sides reordered', () => {
    const base = tree([{ b: 'a' }, { b: 'b' }, { b: 'c' }]);
    const local = tree([{ b: 'c' }, { b: 'b' }, { b: 'a' }]);
    const remote = tree([{ b: 'b' }, { b: 'a' }, { b: 'c' }]);
    expectTree(run(base, local, remote).doc, remote);
  });

  it('places a local child added at the front before its successor', () => {
    const base = tree([{ b: 'a' }, { b: 'b' }]);
    const local = tree([{ b: 'x' }, { b: 'a' }, { b: 'b' }]);
    expectTree(run(base, local, base).doc, local);
  });

  it('resolves a guid added on both sides with different values in favour of remote', () => {
    const base = tree([]);
    const { doc: m, stats } = run(base, tree([{ b: 'n', title: 'L' }]), tree([{ b: 'n', title: 'R' }]));
    expectTree(m, tree([{ b: 'n', title: 'R' }]));
    expect(stats.conflicts).toBe(1);
  });

  it('takes the remote node when the same guid has different kinds', () => {
    const base = tree([]);
    const { doc: m } = run(base, tree([{ b: 'n' }]), tree([{ f: 'n' }]));
    expectTree(m, tree([{ f: 'n' }]));
  });

  it('reports change counts in both directions', () => {
    const base = tree([{ b: 'a' }, { b: 'b' }, { f: 'f' }]);
    const local = tree([{ b: 'a', title: 'A' }, { b: 'b' }, { f: 'f' }, { b: 'l' }]);
    const remote = tree([{ f: 'f', children: [{ b: 'b' }] }, { b: 'r' }]); // a deleted, b moved, r added
    const { stats } = run(base, local, remote);
    // a: edited locally, deleted remotely → kept
    expect(stats.toLocal).toEqual({ adds: 1, updates: 0, moves: 1, deletes: 0 });
    expect(stats.toRemote).toEqual({ adds: 2, updates: 0, moves: 0, deletes: 0 });
  });

  it('never alters roots', () => {
    const base = tree([{ b: 'a' }]);
    const local = structuredClone(base);
    local.nodes[T]!.title = 'Lesezeichenleiste';
    const { doc: m } = run(base, local, base);
    expect(m.nodes[T]!.title).toBe('Bookmarks Toolbar');
  });
});
