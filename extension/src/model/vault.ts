// The vault document: the plaintext bookmark tree every device syncs.
// It is gzipped and encrypted before leaving the browser (see crypto/).

export type Guid = string;
export type NodeKind = 'folder' | 'bookmark';

export interface VNode {
  guid: Guid;
  kind: NodeKind;
  title: string;
  /** Bookmarks only. */
  url?: string;
  /** Folders only, in display order. */
  children?: Guid[];
}

export interface VaultDoc {
  /** Unknown higher formats are refused, never overwritten. */
  format: 1;
  /** +1 per upload; lives inside the ciphertext for rollback detection. */
  seq: number;
  writtenBy: string;
  writtenAt: number;
  /** Every node including the four roots, keyed by guid. */
  nodes: Record<Guid, VNode>;
}

export const VAULT_FORMAT = 1;

// Canonical roots reuse Firefox's fixed GUIDs, so Firefox maps them 1:1.
export const ROOT_TOOLBAR = 'toolbar_____';
export const ROOT_MENU = 'menu________';
export const ROOT_OTHER = 'unfiled_____';
export const ROOT_MOBILE = 'mobile______';
export const ROOT_GUIDS = [ROOT_TOOLBAR, ROOT_MENU, ROOT_OTHER, ROOT_MOBILE] as const;
export type RootGuid = (typeof ROOT_GUIDS)[number];

const ROOT_TITLES: Record<RootGuid, string> = {
  [ROOT_TOOLBAR]: 'Bookmarks Toolbar',
  [ROOT_MENU]: 'Bookmarks Menu',
  [ROOT_OTHER]: 'Other Bookmarks',
  [ROOT_MOBILE]: 'Mobile Bookmarks',
};

const rootSet: ReadonlySet<string> = new Set(ROOT_GUIDS);

export function isRoot(guid: Guid): guid is RootGuid {
  return rootSet.has(guid);
}

/** Canonical (non-localized) title of a root folder. */
export function rootTitle(guid: RootGuid): string {
  return ROOT_TITLES[guid];
}

/** A document holding only the four empty roots. */
export function emptyDoc(): VaultDoc {
  const nodes: Record<Guid, VNode> = {};
  for (const guid of ROOT_GUIDS) {
    nodes[guid] = { guid, kind: 'folder', title: ROOT_TITLES[guid], children: [] };
  }
  return { format: VAULT_FORMAT, seq: 0, writtenBy: '', writtenAt: 0, nodes };
}

/** A random 12-character base64url GUID (72 bits), the same shape Firefox uses. */
export function newGuid(): Guid {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_');
}

/** Maps every child guid to its parent guid. */
export function parentsOf(doc: VaultDoc): Map<Guid, Guid> {
  const parents = new Map<Guid, Guid>();
  for (const node of Object.values(doc.nodes)) {
    for (const child of node.children ?? []) parents.set(child, node.guid);
  }
  return parents;
}

/** Number of bookmarks and folders, not counting the roots. */
export function countNodes(doc: VaultDoc): number {
  let n = 0;
  for (const guid of Object.keys(doc.nodes)) if (!isRoot(guid)) n++;
  return n;
}

export type ViolationKind =
  | 'missing_root'
  | 'guid_mismatch'
  | 'bad_bookmark'
  | 'bad_folder'
  | 'dangling_child'
  | 'multiple_parents'
  | 'root_has_parent'
  | 'cycle'
  | 'unreachable';

export interface Violation {
  kind: ViolationKind;
  guid: Guid;
}

/** Lists every structural problem; an empty list means the tree is valid. */
export function validateTree(doc: VaultDoc): Violation[] {
  const out: Violation[] = [];
  const { nodes } = doc;

  for (const root of ROOT_GUIDS) {
    const n = nodes[root];
    if (!n || n.kind !== 'folder' || !Array.isArray(n.children)) out.push({ kind: 'missing_root', guid: root });
  }

  const parentCount = new Map<Guid, number>();
  for (const [key, node] of Object.entries(nodes)) {
    if (node.guid !== key) out.push({ kind: 'guid_mismatch', guid: key });
    if (node.kind === 'bookmark') {
      if (typeof node.url !== 'string' || node.children !== undefined) out.push({ kind: 'bad_bookmark', guid: key });
    } else if (node.kind === 'folder') {
      if (!Array.isArray(node.children) || node.url !== undefined) out.push({ kind: 'bad_folder', guid: key });
    } else {
      out.push({ kind: 'bad_folder', guid: key });
    }
    for (const child of node.children ?? []) {
      if (!nodes[child]) out.push({ kind: 'dangling_child', guid: child });
      if (isRoot(child)) out.push({ kind: 'root_has_parent', guid: child });
      parentCount.set(child, (parentCount.get(child) ?? 0) + 1);
    }
  }
  for (const [guid, count] of parentCount) {
    if (count > 1) out.push({ kind: 'multiple_parents', guid });
  }

  // Everything must hang off a root; nodes that don't are orphaned or in a cycle.
  const reachable = new Set<Guid>();
  const stack: Guid[] = ROOT_GUIDS.filter((g) => nodes[g]);
  while (stack.length) {
    const g = stack.pop()!;
    if (reachable.has(g)) continue;
    reachable.add(g);
    for (const c of nodes[g]?.children ?? []) if (nodes[c]) stack.push(c);
  }
  const parents = parentsOf(doc);
  for (const guid of Object.keys(nodes)) {
    if (reachable.has(guid)) continue;
    out.push({ kind: inCycle(guid, parents) ? 'cycle' : 'unreachable', guid });
  }
  return out;
}

/** Whether start's ancestor chain loops (start is in, or below, a cycle). */
function inCycle(start: Guid, parents: Map<Guid, Guid>): boolean {
  const seen = new Set<Guid>();
  for (let g: Guid | undefined = start; g !== undefined; g = parents.get(g)) {
    if (seen.has(g)) return true;
    seen.add(g);
  }
  return false;
}

/**
 * Structural equality of two trees: same nodes with the same kind, title,
 * url and child order. Metadata (seq, writer) and root titles, which are
 * localized per browser, are ignored.
 */
export function treesEqual(a: VaultDoc, b: VaultDoc): boolean {
  const ka = Object.keys(a.nodes);
  if (ka.length !== Object.keys(b.nodes).length) return false;
  for (const guid of ka) {
    const x = a.nodes[guid]!;
    const y = b.nodes[guid];
    if (!y || !nodesEqual(x, y, isRoot(guid))) return false;
  }
  return true;
}

export function nodesEqual(x: VNode, y: VNode, ignoreTitle = false): boolean {
  if (x.kind !== y.kind || x.url !== y.url) return false;
  if (!ignoreTitle && x.title !== y.title) return false;
  return arraysEqual(x.children, y.children);
}

function arraysEqual(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export type VaultDocErrorCode = 'unsupported_format' | 'bad_format';

export class VaultDocError extends Error {
  constructor(
    readonly code: VaultDocErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VaultDocError';
  }
}

export function serializeVaultDoc(doc: VaultDoc): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(doc));
}

/** Parses and fully validates a decrypted document. */
export function parseVaultDoc(bytes: Uint8Array): VaultDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new VaultDocError('bad_format', 'vault is not valid JSON');
  }
  if (!isObject(raw) || typeof raw.format !== 'number') {
    throw new VaultDocError('bad_format', 'vault has no format version');
  }
  if (raw.format > VAULT_FORMAT) {
    throw new VaultDocError('unsupported_format', `vault format ${raw.format} is newer than this extension supports; update BookSync`);
  }
  if (
    raw.format !== VAULT_FORMAT ||
    !Number.isSafeInteger(raw.seq) ||
    typeof raw.writtenBy !== 'string' ||
    typeof raw.writtenAt !== 'number' ||
    !isObject(raw.nodes)
  ) {
    throw new VaultDocError('bad_format', 'vault header is malformed');
  }
  const nodes: Record<Guid, VNode> = {};
  for (const [key, value] of Object.entries(raw.nodes)) {
    nodes[key] = parseNode(value);
  }
  const doc: VaultDoc = { format: VAULT_FORMAT, seq: raw.seq as number, writtenBy: raw.writtenBy, writtenAt: raw.writtenAt, nodes };
  const violations = validateTree(doc);
  if (violations.length > 0) {
    const v = violations[0]!;
    throw new VaultDocError('bad_format', `vault tree is invalid: ${v.kind} at ${v.guid}`);
  }
  return doc;
}

function parseNode(value: unknown): VNode {
  if (!isObject(value) || typeof value.guid !== 'string' || typeof value.title !== 'string') {
    throw new VaultDocError('bad_format', 'vault node is malformed');
  }
  if (value.kind === 'bookmark' && typeof value.url === 'string') {
    return { guid: value.guid, kind: 'bookmark', title: value.title, url: value.url };
  }
  if (value.kind === 'folder' && Array.isArray(value.children) && value.children.every((c) => typeof c === 'string')) {
    return { guid: value.guid, kind: 'folder', title: value.title, children: [...(value.children as string[])] };
  }
  throw new VaultDocError('bad_format', `vault node ${value.guid} is malformed`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
