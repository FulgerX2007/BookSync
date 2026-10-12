// Compact tree builders for tests.
import { ROOT_GUIDS, emptyDoc, type Guid, type VaultDoc } from '../src/model/vault';

export type Spec =
  | { b: string; title?: string; url?: string } // bookmark
  | { f: string; title?: string; children?: Spec[] }; // folder

/**
 * Builds a doc from root → children specs. Guids are the spec ids; titles
 * default to the id and urls to https://<id>.example/.
 */
export function doc(roots: Partial<Record<(typeof ROOT_GUIDS)[number], Spec[]>>, seq = 0): VaultDoc {
  const d = emptyDoc();
  d.seq = seq;
  const add = (parent: Guid, specs: Spec[]) => {
    for (const s of specs) {
      if ('b' in s) {
        d.nodes[s.b] = { guid: s.b, kind: 'bookmark', title: s.title ?? s.b, url: s.url ?? `https://${s.b}.example/` };
        d.nodes[parent]!.children!.push(s.b);
      } else {
        d.nodes[s.f] = { guid: s.f, kind: 'folder', title: s.title ?? s.f, children: [] };
        d.nodes[parent]!.children!.push(s.f);
        add(s.f, s.children ?? []);
      }
    }
  };
  for (const [root, specs] of Object.entries(roots)) add(root, specs ?? []);
  return d;
}

/** Renders a doc as an indented outline, for readable assertion diffs. */
export function outline(d: VaultDoc): string {
  const lines: string[] = [];
  const walk = (g: Guid, depth: number) => {
    const n = d.nodes[g];
    if (!n) {
      lines.push(`${'  '.repeat(depth)}<missing ${g}>`);
      return;
    }
    lines.push(`${'  '.repeat(depth)}${n.kind === 'folder' ? '+' : '-'} ${g}${n.title !== g ? ` "${n.title}"` : ''}${n.url && n.url !== `https://${g}.example/` ? ` ${n.url}` : ''}`);
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  for (const r of ROOT_GUIDS) walk(r, 0);
  return lines.join('\n');
}
