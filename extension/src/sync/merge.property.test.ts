import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbEdits, arbTree, applyEdits } from '../../test/arbitraries';
import { isRoot, parentsOf, treesEqual, validateTree, type VaultDoc } from '../model/vault';
import { merge3 } from './merge';

const scenario = fc
  .tuple(arbTree, arbEdits(), arbEdits())
  .map(([base, le, re]) => ({ base, local: applyEdits(base, le, 'l'), remote: applyEdits(base, re, 'r') }));

const runs = { numRuns: Number(process.env.FC_RUNS ?? 400) };

describe('merge3 properties', () => {
  it('returns local unchanged when remote did nothing', () => {
    fc.assert(
      fc.property(arbTree, arbEdits(), (base, edits) => {
        const local = applyEdits(base, edits, 'l');
        expect(treesEqual(merge3(base, local, base).doc, local)).toBe(true);
      }),
      runs,
    );
  });

  it('returns remote unchanged when local did nothing', () => {
    fc.assert(
      fc.property(arbTree, arbEdits(), (base, edits) => {
        const remote = applyEdits(base, edits, 'r');
        expect(treesEqual(merge3(base, base, remote).doc, remote)).toBe(true);
      }),
      runs,
    );
  });

  it('returns the common result when both sides made the same edits', () => {
    fc.assert(
      fc.property(arbTree, arbEdits(), (base, edits) => {
        const same = applyEdits(base, edits, 'x');
        expect(treesEqual(merge3(base, same, same).doc, same)).toBe(true);
      }),
      runs,
    );
  });

  it('always produces a valid tree', () => {
    fc.assert(
      fc.property(scenario, ({ base, local, remote }) => {
        expect(validateTree(merge3(base, local, remote).doc)).toEqual([]);
      }),
      runs,
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(scenario, ({ base, local, remote }) => {
        expect(merge3(base, local, remote)).toEqual(merge3(structuredClone(base), structuredClone(local), structuredClone(remote)));
      }),
      runs,
    );
  });

  it('never loses a node added or edited on exactly one side', () => {
    const editedOrAdded = (base: VaultDoc, side: VaultDoc) => {
      const pb = parentsOf(base);
      const ps = parentsOf(side);
      return Object.values(side.nodes)
        .filter((n) => !isRoot(n.guid))
        .filter((n) => {
          const b = base.nodes[n.guid];
          return !b || b.title !== n.title || b.url !== n.url || pb.get(n.guid) !== ps.get(n.guid);
        })
        .map((n) => n.guid);
    };
    fc.assert(
      fc.property(scenario, ({ base, local, remote }) => {
        const merged = merge3(base, local, remote).doc;
        for (const g of [...editedOrAdded(base, local), ...editedOrAdded(base, remote)]) {
          expect(merged.nodes[g], g).toBeDefined();
        }
      }),
      runs,
    );
  });

  it('is stable: a device that merged its own result again changes nothing', () => {
    fc.assert(
      fc.property(scenario, ({ base, local, remote }) => {
        const m = merge3(base, local, remote).doc;
        // The remote device later sees m as the new remote with its own state unchanged.
        expect(treesEqual(merge3(remote, remote, m).doc, m)).toBe(true);
        // This device, having applied m, merges against the uploaded m.
        expect(treesEqual(merge3(m, m, m).doc, m)).toBe(true);
      }),
      runs,
    );
  });
});
