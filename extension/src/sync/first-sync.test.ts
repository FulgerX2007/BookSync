import { describe, expect, it } from 'vitest';
import { doc, outline, type Spec } from '../../test/builders';
import { ROOT_OTHER, ROOT_TOOLBAR, emptyDoc, validateTree, type VaultDoc } from '../model/vault';
import { firstSync } from './first-sync';

const T = ROOT_TOOLBAR;
const O = ROOT_OTHER;
const tree = (toolbar: Spec[], other: Spec[] = []) => doc({ [T]: toolbar, [O]: other });

function run(local: VaultDoc, remote: VaultDoc | null) {
  const res = firstSync(local, remote);
  expect(validateTree(res.doc)).toEqual([]);
  return res;
}

describe('firstSync', () => {
  it('bootstraps the account from local when there is no remote vault', () => {
    const local = tree([{ b: 'a' }, { f: 'f', children: [{ b: 'b' }] }]);
    const { doc: d, guidRemap } = run(local, null);
    expect(d).toEqual(local);
    expect(guidRemap.size).toBe(0);
  });

  it('matches identical content with different guids without adding anything', () => {
    const local = tree([
      { b: 'l1', url: 'https://a.example/', title: 'A' },
      { f: 'lf', title: 'Work', children: [{ b: 'l2', url: 'https://b.example/', title: 'B' }] },
    ]);
    const remote = tree([
      { b: 'r1', url: 'https://a.example/', title: 'A' },
      { f: 'rf', title: 'Work', children: [{ b: 'r2', url: 'https://b.example/', title: 'B' }] },
    ]);
    const { doc: d, guidRemap } = run(local, remote);
    expect(outline(d)).toBe(outline(remote));
    expect(Object.fromEntries(guidRemap)).toEqual({ l1: 'r1', lf: 'rf', l2: 'r2' });
  });

  it('adds only unmatched local nodes, after their local predecessor', () => {
    const local = tree([
      { b: 'la', url: 'https://a.example/' },
      { b: 'lx', url: 'https://x.example/' },
      { b: 'lc', url: 'https://c.example/' },
    ]);
    const remote = tree([
      { b: 'ra', url: 'https://a.example/' },
      { b: 'rb', url: 'https://b.example/' },
      { b: 'rc', url: 'https://c.example/' },
    ]);
    const { doc: d } = run(local, remote);
    expect(d.nodes[T]!.children).toEqual(['ra', 'lx', 'rb', 'rc']);
  });

  it('places a local node that comes first before its successor', () => {
    const local = tree([{ b: 'lx' }, { b: 'la', url: 'https://a.example/' }]);
    const remote = tree([{ b: 'rz' }, { b: 'ra', url: 'https://a.example/' }]);
    expect(run(local, remote).doc.nodes[T]!.children).toEqual(['rz', 'lx', 'ra']);
  });

  it('matches duplicate URLs one to one', () => {
    const u = 'https://dup.example/';
    const local = tree([{ b: 'l1', url: u }, { b: 'l2', url: u }]);
    const remote = tree([{ b: 'r1', url: u }]);
    const { doc: d, guidRemap } = run(local, remote);
    expect(d.nodes[T]!.children).toEqual(['r1', 'l2']);
    expect(guidRemap.get('l1')).toBe('r1');
    expect(guidRemap.has('l2')).toBe(false);
  });

  it('prefers the same title among same-URL candidates', () => {
    const u = 'https://dup.example/';
    const local = tree([{ b: 'l', url: u, title: 'Mine' }]);
    const remote = tree([{ b: 'r1', url: u, title: 'Other' }, { b: 'r2', url: u, title: 'Mine' }]);
    expect(run(local, remote).guidRemap.get('l')).toBe('r2');
  });

  it('matches URLs after normalization', () => {
    const local = tree([{ b: 'l', url: 'HTTPS://Example.COM' }]);
    const remote = tree([{ b: 'r', url: 'https://example.com/' }]);
    expect(run(local, remote).guidRemap.get('l')).toBe('r');
  });

  it('does not cross-match same-titled folders under different parents', () => {
    const local = tree([{ f: 'lf', title: 'News' }]);
    const remote = tree([], [{ f: 'rf', title: 'News' }]);
    const { doc: d } = run(local, remote);
    expect(d.nodes[T]!.children).toEqual(['lf']);
    expect(d.nodes[O]!.children).toEqual(['rf']);
  });

  it('matches by guid first, so an edited bookmark from an earlier membership is not duplicated', () => {
    const local = tree([{ b: 'g1', title: 'Renamed', url: 'https://moved.example/' }]);
    const remote = tree([{ b: 'g1', title: 'Original' }, { b: 'g2', url: 'https://moved.example/' }]);
    const { doc: d } = run(local, remote);
    expect(d.nodes[T]!.children).toEqual(['g1', 'g2']);
    expect(d.nodes.g1!.title).toBe('Original'); // remote values win on join
  });

  it('gives a fresh guid to a local node whose guid exists remotely as another kind', () => {
    const local = tree([{ b: 'clash' }]);
    const remote = tree([{ f: 'clash' }]);
    const { doc: d, guidRemap } = run(local, remote);
    const fresh = guidRemap.get('clash')!;
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(d.nodes[T]!.children).toEqual(['clash', fresh]);
    expect(d.nodes[fresh]!.kind).toBe('bookmark');
  });

  it('brings an unmatched local folder with its whole subtree', () => {
    const local = tree([{ f: 'lf', title: 'New', children: [{ b: 'x' }, { f: 'sub', children: [{ b: 'y' }] }] }]);
    const remote = tree([{ b: 'r' }]);
    const { doc: d } = run(local, remote);
    expect(outline(d)).toBe(outline(tree([{ b: 'r' }, { f: 'lf', title: 'New', children: [{ b: 'x' }, { f: 'sub', children: [{ b: 'y' }] }] }])));
  });

  it('matches inside matched folders recursively', () => {
    const local = tree([{ f: 'lf', title: 'Work', children: [{ f: 'ls', title: 'Deep', children: [{ b: 'lb', url: 'https://deep.example/' }, { b: 'new' }] }] }]);
    const remote = tree([{ f: 'rf', title: 'Work', children: [{ f: 'rs', title: 'Deep', children: [{ b: 'rb', url: 'https://deep.example/' }] }] }]);
    const { doc: d } = run(local, remote);
    expect(d.nodes.rs!.children).toEqual(['rb', 'new']);
  });

  it('keeps the remote tree as is when local is empty', () => {
    const remote = tree([{ b: 'a' }], [{ f: 'f' }]);
    const { doc: d, guidRemap } = run(emptyDoc(), remote);
    expect(d).toEqual(remote);
    expect(guidRemap.size).toBe(0);
  });

  it('adds everything when the remote vault is empty but exists', () => {
    const local = tree([{ b: 'a' }], [{ f: 'f', children: [{ b: 'b' }] }]);
    expect(outline(run(local, emptyDoc()).doc)).toBe(outline(local));
  });

  it('never deletes or renames remote content', () => {
    const local = tree([{ b: 'l', url: 'https://same.example/', title: 'Local title' }]);
    const remote = tree([{ b: 'r', url: 'https://same.example/', title: 'Remote title' }, { b: 'keep' }]);
    const { doc: d } = run(local, remote);
    expect(d.nodes.r!.title).toBe('Remote title');
    expect(d.nodes.keep).toBeDefined();
  });
});

describe('firstSync properties', () => {
  it('keeps every remote node unchanged and accounts for every local node', async () => {
    const fc = (await import('fast-check')).default;
    const { arbTree, arbEdits, applyEdits } = await import('../../test/arbitraries');
    fc.assert(
      fc.property(arbTree, arbEdits(), (remote, edits) => {
        // A local tree sharing some content (and some guids) with remote.
        const local = applyEdits(remote, edits, 'l');
        const { doc: d, guidRemap } = firstSync(local, remote);
        expect(validateTree(d)).toEqual([]);
        for (const [g, n] of Object.entries(remote.nodes)) {
          expect(d.nodes[g]?.title).toBe(n.title);
          expect(d.nodes[g]?.url).toBe(n.url);
        }
        for (const g of Object.keys(local.nodes)) {
          expect(d.nodes[guidRemap.get(g) ?? g], g).toBeDefined();
        }
      }),
      { numRuns: 300 },
    );
  });
});
