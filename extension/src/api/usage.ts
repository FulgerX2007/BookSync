// How much of the account's vault limit the bookmarks use (GET
// /v1/account/usage), and how the popup describes it: a quiet bar normally,
// a warning card from WARN_AT, a red one from FULL_AT.

export interface Usage {
  /** Size of the current encrypted vault version on the server. */
  vaultBytes: number;
  /** This account's limit (its own, or the server default). */
  maxVaultBytes: number;
}

export type UsageLevel = 'ok' | 'warn' | 'full';

export const WARN_AT = 0.8;
export const FULL_AT = 0.95;

/** Parses a usage response; null when it is malformed. */
export function parseUsage(v: unknown): Usage | null {
  const u = v as Partial<Usage> | null;
  if (!u || typeof u.vaultBytes !== 'number' || typeof u.maxVaultBytes !== 'number') return null;
  if (!(u.vaultBytes >= 0) || !(u.maxVaultBytes > 0)) return null;
  return { vaultBytes: u.vaultBytes, maxVaultBytes: u.maxVaultBytes };
}

export function usageRatio(u: Usage): number {
  return Math.min(1, u.vaultBytes / u.maxVaultBytes);
}

export function usageLevel(u: Usage): UsageLevel {
  const r = u.vaultBytes / u.maxVaultBytes;
  if (r >= FULL_AT) return 'full';
  if (r >= WARN_AT) return 'warn';
  return 'ok';
}

/** Whole percent for display: 0 only for an empty vault, never above 100. */
export function usagePercent(u: Usage): number {
  if (u.vaultBytes <= 0) return 0;
  return Math.min(100, Math.max(1, Math.floor((u.vaultBytes / u.maxVaultBytes) * 100)));
}

/** Binary units, like the server: 900 B, 230 KB, 1.5 MB. */
export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const s = i === 0 || v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
  return `${s} ${units[i]}`;
}

export interface UsageView {
  level: UsageLevel;
  percent: number;
  /** "230 KB of 1 MB" */
  amount: string;
  /** Shown on the warning card only. */
  note: string | null;
}

export function describeUsage(u: Usage): UsageView {
  const level = usageLevel(u);
  const notes: Record<UsageLevel, string | null> = {
    ok: null,
    warn: 'Close to this account’s limit. At the limit, syncing stops until bookmarks are removed or the server admin raises it.',
    full: 'Almost full: new bookmarks may not sync. Remove some, or ask the server admin to raise this account’s limit.',
  };
  return { level, percent: usagePercent(u), amount: `${formatBytes(u.vaultBytes)} of ${formatBytes(u.maxVaultBytes)}`, note: notes[level] };
}
