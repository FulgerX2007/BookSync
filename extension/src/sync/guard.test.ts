import { describe, expect, it } from 'vitest';
import { doc, type Spec } from '../../test/builders';
import { ROOT_TOOLBAR, emptyDoc } from '../model/vault';
import { GUARD_MIN_DELETIONS, confirmationCovers, guardCheck } from './guard';

const many = (n: number, prefix = 'b'): Spec[] => Array.from({ length: n }, (_, i) => ({ b: `${prefix}${i}` }));
const tree = (specs: Spec[]) => doc({ [ROOT_TOOLBAR]: specs });

describe('guardCheck', () => {
  it('lets small or proportionally minor deletions through', () => {
    // 19 of 19 deleted: below the absolute minimum.
    expect(guardCheck(tree(many(19)), tree(many(19)), emptyDoc(), 1)).toBeNull();
    // 25 of 200 deleted: above the minimum but only 12.5 %.
    const big = tree(many(200));
    const fewer = tree(many(175));
    expect(guardCheck(big, big, fewer, 1)).toBeNull();
  });

  it('blocks deletions toward the server', () => {
    const before = tree(many(40));
    const after = tree(many(10));
    expect(guardCheck(after, before, after, 7)).toEqual({ remoteVersion: 7, deletionsToLocal: 0, deletionsToRemote: 30 });
  });

  it('blocks deletions toward this browser', () => {
    const before = tree(many(40));
    const after = tree(many(10));
    expect(guardCheck(before, after, after, 8)).toEqual({ remoteVersion: 8, deletionsToLocal: 30, deletionsToRemote: 0 });
  });

  it('counts exactly at the threshold', () => {
    const before = tree(many(GUARD_MIN_DELETIONS * 2));
    const after = tree(many(GUARD_MIN_DELETIONS));
    expect(guardCheck(after, before, after, 1)).not.toBeNull();
  });
});

describe('confirmationCovers', () => {
  const pending = { remoteVersion: 5, deletionsToLocal: 0, deletionsToRemote: 30 };
  it('accepts the same situation or fewer deletions', () => {
    expect(confirmationCovers(pending, pending)).toBe(true);
    expect(confirmationCovers(pending, { ...pending, deletionsToRemote: 25 })).toBe(true);
  });
  it('rejects a different server version, more deletions, or no confirmation', () => {
    expect(confirmationCovers(pending, { ...pending, remoteVersion: 6 })).toBe(false);
    expect(confirmationCovers(pending, { ...pending, deletionsToLocal: 1 })).toBe(false);
    expect(confirmationCovers(undefined, pending)).toBe(false);
  });
});
