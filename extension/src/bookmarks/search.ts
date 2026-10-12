// Substring search over the browser's bookmarks, the same on every browser
// (bookmarks.search is word-based in Chrome and differs in Firefox).
//
// Every query word must occur in the title or the URL; matching ignores case
// and accents. Results whose title holds every word come first, then the
// rest, each group in tree order.
import type { LocalTree } from '../browser/adapter';
import { isRootId, pathOf, treeOrder } from './tree';

export type NodeKind = 'folder' | 'bookmark';

export interface SearchResult {
  id: string;
  kind: NodeKind;
  title: string;
  url?: string;
  /** Titles of the folders above the node, root first. */
  path: string[];
  /** Every query word occurs in the title (these rank first). */
  allInTitle: boolean;
}

export interface SearchOptions {
  limit?: number;
  kinds?: readonly NodeKind[];
}

interface Entry {
  id: string;
  kind: NodeKind;
  title: string;
  url?: string;
  title_: string;
  url_: string;
}

export interface SearchIndex {
  tree: LocalTree;
  entries: Entry[];
}

/** Case- and accent-insensitive form: compatibility-decomposed, marks removed, lower case. */
export function normalize(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Percent-encoded URLs (e.g. /caf%C3%A9) match what the user types (café). */
function decodeUrl(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

/** Precomputes the normalized strings once per tree load. Roots are not searchable. */
export function createSearchIndex(tree: LocalTree): SearchIndex {
  const entries: Entry[] = [];
  for (const id of treeOrder(tree)) {
    if (isRootId(tree, id)) continue;
    const n = tree.nodes.get(id)!;
    entries.push({
      id,
      kind: n.kind,
      title: n.title,
      ...(n.url !== undefined ? { url: n.url } : {}),
      title_: normalize(n.title),
      url_: n.kind === 'bookmark' && n.url !== undefined ? normalize(decodeUrl(n.url)) : '',
    });
  }
  return { tree, entries };
}

export function search(index: SearchIndex, query: string, { limit = Infinity, kinds = ['bookmark', 'folder'] }: SearchOptions = {}): SearchResult[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0 || limit <= 0) return [];
  const first: Entry[] = [];
  const rest: Entry[] = [];
  for (const e of index.entries) {
    if (!kinds.includes(e.kind)) continue;
    let allInTitle = true;
    let matches = true;
    for (const w of words) {
      if (e.title_.includes(w)) continue;
      allInTitle = false;
      if (!e.url_.includes(w)) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    (allInTitle ? first : rest).push(e);
    if (first.length >= limit) break;
  }
  const result = (e: Entry, allInTitle: boolean): SearchResult => ({
    id: e.id,
    kind: e.kind,
    title: e.title,
    ...(e.url !== undefined ? { url: e.url } : {}),
    path: pathOf(index.tree, e.id),
    allInTitle,
  });
  const out = first.slice(0, limit).map((e) => result(e, true));
  for (const e of rest) {
    if (out.length >= limit) break;
    out.push(result(e, false));
  }
  return out;
}
