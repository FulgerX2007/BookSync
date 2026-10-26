// The settings page shows the server's version history by day (the server
// keeps the current version plus the newest version of each day).

export interface DayGroup<T> {
  /** Local calendar day, "YYYY-MM-DD". */
  day: string;
  /** Newest first. */
  versions: T[];
}

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Groups versions by the local day they were saved, newest day and version first. */
export function groupByDay<T extends { version: number; createdAt: string }>(versions: readonly T[]): DayGroup<T>[] {
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const groups: DayGroup<T>[] = [];
  for (const v of sorted) {
    const day = localDay(Date.parse(v.createdAt));
    const last = groups.at(-1);
    if (last?.day === day) last.versions.push(v);
    else groups.push({ day, versions: [v] });
  }
  return groups;
}
