import { describe, expect, it } from 'vitest';
import { groupByDay } from './history';

const at = (y: number, m: number, d: number, h: number) => new Date(y, m - 1, d, h).toISOString();

describe('groupByDay', () => {
  it('groups by local day, newest day and newest version first', () => {
    const versions = [
      { version: 3, createdAt: at(2026, 10, 25, 18) },
      { version: 1, createdAt: at(2026, 10, 24, 9) },
      { version: 5, createdAt: at(2026, 10, 26, 11) },
      { version: 4, createdAt: at(2026, 10, 26, 10) },
    ];
    expect(groupByDay(versions).map((g) => [g.day, g.versions.map((v) => v.version)])).toEqual([
      ['2026-10-26', [5, 4]],
      ['2026-10-25', [3]],
      ['2026-10-24', [1]],
    ]);
  });

  it('is empty for no versions', () => {
    expect(groupByDay([])).toEqual([]);
  });
});
