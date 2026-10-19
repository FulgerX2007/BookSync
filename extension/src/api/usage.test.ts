import { describe, expect, it } from 'vitest';
import { describeUsage, formatBytes, parseUsage, usageLevel, usagePercent, usageRatio } from './usage';

const MB = 1 << 20;
const u = (vaultBytes: number, maxVaultBytes = MB) => ({ vaultBytes, maxVaultBytes });

describe('usage', () => {
  it('parses only well-formed reports', () => {
    expect(parseUsage({ vaultBytes: 10, maxVaultBytes: 100 })).toEqual(u(10, 100));
    expect(parseUsage({ vaultBytes: 10, maxVaultBytes: 100, extra: 1 })).toEqual(u(10, 100));
    for (const bad of [null, {}, { vaultBytes: '1', maxVaultBytes: 2 }, { vaultBytes: 1, maxVaultBytes: 0 }, { vaultBytes: -1, maxVaultBytes: 2 }, { vaultBytes: Number.NaN, maxVaultBytes: 2 }]) {
      expect(parseUsage(bad)).toBeNull();
    }
  });

  it('switches level at 80 % and 95 %', () => {
    expect(usageLevel(u(0))).toBe('ok');
    expect(usageLevel(u(MB * 0.79))).toBe('ok');
    expect(usageLevel(u(MB * 0.8))).toBe('warn');
    expect(usageLevel(u(MB * 0.949))).toBe('warn');
    expect(usageLevel(u(MB * 0.95))).toBe('full');
    expect(usageLevel(u(MB * 1.2))).toBe('full'); // a lowered limit can leave a vault above it
  });

  it('shows whole percents, at least 1 for a non-empty vault and at most 100', () => {
    expect(usagePercent(u(0))).toBe(0);
    expect(usagePercent(u(1))).toBe(1);
    expect(usagePercent(u(MB * 0.236))).toBe(23);
    expect(usagePercent(u(MB * 0.999))).toBe(99);
    expect(usagePercent(u(MB * 3))).toBe(100);
    expect(usageRatio(u(MB * 3))).toBe(1);
  });

  it('formats sizes in binary units', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(235_520)).toBe('230 KB');
    expect(formatBytes(MB)).toBe('1 MB');
    expect(formatBytes(1.5 * MB)).toBe('1.5 MB');
    expect(formatBytes(10 * MB)).toBe('10 MB');
  });

  it('describes each level for the popup', () => {
    expect(describeUsage(u(235_520))).toEqual({ level: 'ok', percent: 22, amount: '230 KB of 1 MB', note: null });
    const warn = describeUsage(u(MB * 0.86));
    expect(warn).toMatchObject({ level: 'warn', percent: 86 });
    expect(warn.note).toMatch(/syncing stops/);
    expect(describeUsage(u(MB * 0.97)).note).toMatch(/may not sync/);
  });
});
