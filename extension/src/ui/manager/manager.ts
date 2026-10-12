// Bookmark manager: the synced bookmarks as a tree, refreshed live when sync
// or the browser changes them, with create / rename / edit / delete. All
// decisions live in src/bookmarks; this page only renders and wires events.
// Anything that edits holds the refresh gate, so a refresh never destroys
// an inline rename, an open dialog or one of our own multi-step operations.
import type { LocalTree } from '../../browser/adapter';
import { resolveDrop, zoneAt, type Zone } from '../../bookmarks/drop';
import { createBookmark, createFolder, deleteMany, moveMany, rename, setUrl, type Position } from '../../bookmarks/ops';
import { createRefreshGate, type Release } from '../../bookmarks/refresh';
import { createSearchIndex, search, type SearchIndex } from '../../bookmarks/search';
import { emptySelection, pruneSelection, select, type Selection } from '../../bookmarks/selection';
import { countSubtree, isRootId, normalizeSelection, rootIds, visibleOrder } from '../../bookmarks/tree';
import { ROOT_OTHER } from '../../model/vault';
import { ext } from '../../platform/ext';
import { openBookmarks } from '../shared/bookmarks';
import { byId, h, replace } from '../shared/dom';
import { errorText } from '../shared/errors';
import { RpcError } from '../shared/rpc';
import { bookmarkDialog, confirmDialog } from './dialogs';

const bookmarks = openBookmarks();
const main = byId('manager-main');
const notice = byId('manager-notice');
const toolbar = byId('manager-toolbar');

let tree: LocalTree | null = null;
let index: SearchIndex | null = null;
/** While non-empty, a flat result list replaces the tree. */
let query = '';
/** Expanded folders; the roots start expanded. */
let expanded: Set<string> | null = null;
let selection: Selection = emptySelection;
/** Why the tree could not be read (cleared by the next good read). */
let loadError: { text: string; settings: boolean } | null = null;
/** The outcome of the user's last action (kept until the next one). */
let message: string | null = null;

const gate = createRefreshGate({ refresh: load });

// ---- notices ------------------------------------------------------------------

function renderNotice(): void {
  const parts: Node[] = [];
  if (loadError) {
    parts.push(h('span', {}, loadError.text));
    if (loadError.settings) parts.push(h('button', { type: 'button', onclick: () => void ext().runtime.openOptionsPage() }, 'Open settings'));
  } else if (message) {
    parts.push(h('span', {}, message), h('button', { type: 'button', class: 'link', 'aria-label': 'Dismiss', onclick: () => setMessage(null) }, '×'));
  }
  replace(notice, ...parts);
  notice.hidden = parts.length === 0;
}

function setMessage(text: string | null): void {
  message = text;
  renderNotice();
}

// ---- tree ---------------------------------------------------------------------

const rowOf = (id: string) => main.querySelector<HTMLElement>(`.node-row[data-id="${CSS.escape(id)}"]`);

function displayTitle(t: LocalTree, id: string): string {
  const n = t.nodes.get(id)!;
  return n.title || (n.kind === 'folder' ? 'Untitled folder' : (n.url ?? ''));
}

function nodeItem(t: LocalTree, id: string): HTMLLIElement {
  const n = t.nodes.get(id)!;
  const folder = n.kind === 'folder';
  const root = isRootId(t, id);
  const open = folder && expanded!.has(id);
  const kids = n.children ?? [];
  const title = displayTitle(t, id);
  const row = h(
    'div',
    {
      class: `node-row${selection.selected.has(id) ? ' selected' : ''}`,
      'data-id': id,
      'data-kind': n.kind,
      title: n.url !== undefined ? `${title}\n${n.url}` : title,
      draggable: root ? undefined : 'true',
    },
    folder
      ? h('button', { class: 'twisty', type: 'button', 'data-toggle': id, 'aria-expanded': String(open), 'aria-label': `${open ? 'Collapse' : 'Expand'} ${title}` }, open ? '▾' : '▸')
      : h('span', { class: 'twisty leaf', 'aria-hidden': 'true' }),
    h('span', { class: 'icon', 'aria-hidden': 'true' }, folder ? '📁' : '🔖'),
    h('span', { class: 'title' }, title),
    folder ? h('span', { class: 'count', title: `${kids.length} item(s)` }, String(kids.length)) : h('span', { class: 'url' }, n.url ?? ''),
    root
      ? null
      : h(
          'span',
          { class: 'actions' },
          h('button', { type: 'button', class: 'act', 'data-action': 'edit', 'aria-label': `${folder ? 'Rename' : 'Edit'} ${title}`, title: folder ? 'Rename' : 'Edit' }, '✎'),
          h('button', { type: 'button', class: 'act', 'data-action': 'delete', 'aria-label': `Delete ${title}`, title: 'Delete' }, '🗑'),
        ),
  );
  return h('li', { class: root ? 'root' : '' }, row, open && kids.length > 0 ? h('ul', {}, ...kids.map((c) => nodeItem(t, c))) : null);
}

function renderResults(): void {
  const results = index ? search(index, query) : [];
  replace(
    main,
    results.length === 0
      ? h('p', { id: 'no-results', class: 'muted' }, 'No bookmarks or folders match.')
      : h(
          'ul',
          { class: 'results', id: 'results' },
          ...results.map((r) =>
            h(
              'li',
              { class: 'result', 'data-reveal': r.id, title: r.url !== undefined ? `${r.title}\n${r.url}` : r.title },
              h('span', { class: 'icon', 'aria-hidden': 'true' }, r.kind === 'folder' ? '📁' : '🔖'),
              h('span', { class: 'title' }, r.title || r.url || 'Untitled folder'),
              h('span', { class: 'path muted' }, r.path.join(' › ')),
              r.url !== undefined ? h('span', { class: 'url' }, r.url) : null,
            ),
          ),
        ),
  );
}

function render(): void {
  if (!tree) return;
  if (query.trim()) {
    renderResults();
    updateToolbar();
    return;
  }
  const scroller = document.scrollingElement;
  const top = scroller?.scrollTop ?? 0;
  const t = tree;
  replace(main, h('ul', { class: 'tree', id: 'tree' }, ...rootIds(t).map((id) => nodeItem(t, id))));
  if (scroller) scroller.scrollTop = top;
  updateToolbar();
}

/** Leaves the search, opens the node's folders, selects it and scrolls it into view. */
function reveal(id: string): void {
  const t = tree;
  if (!t?.nodes.has(id) || !expanded) return;
  query = '';
  searchInput.value = '';
  for (let p = t.nodes.get(id)?.parentId; p; p = t.nodes.get(p)?.parentId) expanded.add(p);
  selectOnly(id);
  render();
  rowOf(id)?.scrollIntoView({ block: 'center' });
}

/** Repaints the selection without rebuilding the rows. */
function paintSelection(): void {
  for (const el of main.querySelectorAll('.node-row.selected')) el.classList.remove('selected');
  for (const id of selection.selected) rowOf(id)?.classList.add('selected');
  updateToolbar();
}

function toggle(id: string): void {
  if (!expanded) return;
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  render();
}

function selectOnly(id: string): void {
  selection = { selected: new Set([id]), anchor: id };
}

async function load(): Promise<void> {
  try {
    const t = await bookmarks.load();
    tree = t;
    index = createSearchIndex(t);
    expanded = expanded ? new Set([...expanded].filter((id) => t.nodes.has(id))) : new Set(rootIds(t));
    selection = pruneSelection(selection, (id) => t.nodes.has(id));
    loadError = null;
    render();
  } catch (e) {
    loadError = e instanceof RpcError && e.code === 'roots_changed' ? { text: errorText(e), settings: true } : { text: `Could not read your bookmarks: ${errorText(e)}`, settings: false };
  }
  renderNotice();
}

// ---- actions --------------------------------------------------------------------

/** Runs an edit with the refresh gate held, then refreshes once; errors become the notice. */
async function run(op: () => Promise<void>): Promise<void> {
  const release = gate.hold();
  setMessage(null);
  try {
    await op();
  } catch (e) {
    setMessage(errorText(e));
  } finally {
    release(true);
  }
}

/** Where a new item goes: into the selected folder, after the selected bookmark, else Other bookmarks. */
function newItemTarget(t: LocalTree): { parentId: string; after: Position } {
  if (selection.selected.size === 1) {
    const [id] = selection.selected;
    const n = t.nodes.get(id!);
    if (n?.kind === 'folder') return { parentId: n.id, after: 'end' };
    if (n) return { parentId: n.parentId, after: n.id };
  }
  return { parentId: t.roots[ROOT_OTHER] ?? rootIds(t)[0]!, after: 'end' };
}

function startRename(id: string): void {
  const t = tree;
  const span = rowOf(id)?.querySelector('.title');
  if (!t || !span || isRootId(t, id)) return;
  const release = gate.hold();
  const old = t.nodes.get(id)?.title ?? '';
  const input = h('input', { type: 'text', class: 'rename', value: old, 'aria-label': 'Name' });
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit: boolean) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    try {
      if (commit && value !== '' && value !== old) await rename(bookmarks.adapter, t, id, value);
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      release(true);
    }
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void finish(true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      void finish(false);
    }
  });
  input.addEventListener('blur', () => void finish(true));
  for (const type of ['click', 'dblclick']) input.addEventListener(type, (ev) => ev.stopPropagation());
}

async function newFolder(): Promise<void> {
  const t = tree;
  if (!t) return;
  const { parentId, after } = newItemTarget(t);
  const release = gate.hold();
  try {
    const id = await createFolder(bookmarks.adapter, t, parentId, after, 'New folder');
    expanded?.add(parentId);
    selectOnly(id);
    await load();
    startRename(id); // holds the gate itself until the name is in
    release();
  } catch (e) {
    setMessage(errorText(e));
    release(true);
  }
}

async function newBookmark(): Promise<void> {
  const t = tree;
  if (!t) return;
  const { parentId, after } = newItemTarget(t);
  const release = gate.hold();
  try {
    await bookmarkDialog({
      heading: 'New bookmark',
      title: '',
      url: '',
      submitLabel: 'Add',
      onSubmit: async (title, url) => {
        const id = await createBookmark(bookmarks.adapter, t, parentId, after, { title, url });
        expanded?.add(parentId);
        selectOnly(id);
      },
    });
  } finally {
    release(true);
  }
}

async function editBookmark(id: string): Promise<void> {
  const t = tree;
  const n = t?.nodes.get(id);
  if (!t || !n || n.kind !== 'bookmark') return;
  const release = gate.hold();
  try {
    await bookmarkDialog({
      heading: 'Edit bookmark',
      title: n.title,
      url: n.url ?? '',
      submitLabel: 'Save',
      onSubmit: async (title, url) => {
        if (url !== n.url) await setUrl(bookmarks.adapter, t, id, url);
        if (title !== n.title) await rename(bookmarks.adapter, t, id, title);
      },
    });
  } finally {
    release(true);
  }
}

function edit(id: string): void {
  if (tree?.nodes.get(id)?.kind === 'folder') startRename(id);
  else void editBookmark(id);
}

function describeCount({ bookmarks: b, folders: f }: { bookmarks: number; folders: number }): string {
  const parts = [];
  if (f > 0) parts.push(`${f} folder${f === 1 ? '' : 's'}`);
  if (b > 0 || f === 0) parts.push(`${b} bookmark${b === 1 ? '' : 's'}`);
  return parts.join(' and ');
}

async function deleteNodes(ids: Iterable<string>): Promise<void> {
  const t = tree;
  if (!t) return;
  const list = normalizeSelection(t, ids);
  if (list.length === 0) return;
  const count = countSubtree(t, list);
  if (count.folders > 0 || list.length > 1) {
    const release = gate.hold();
    const ok = await confirmDialog(
      `Delete ${describeCount(count)}?`,
      'Your other browsers delete them too when they sync. If this is a large share of your bookmarks, the BookSync popup asks you to confirm the sync.',
      'Delete',
    ).finally(() => release());
    if (!ok) return;
  }
  await run(async () => {
    await deleteMany(bookmarks.adapter, t, list);
    selection = emptySelection;
  });
}

// ---- toolbar --------------------------------------------------------------------

const searchInput = h('input', { id: 'manager-search', type: 'search', placeholder: 'Search bookmarks', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search bookmarks' });
searchInput.addEventListener('input', () => {
  query = searchInput.value;
  render();
});
searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && searchInput.value !== '') {
    ev.preventDefault();
    searchInput.value = '';
    query = '';
    render();
  }
});

const newFolderButton = h('button', { id: 'new-folder', type: 'button', onclick: () => void newFolder() }, 'New folder');
const newBookmarkButton = h('button', { id: 'new-bookmark', type: 'button', onclick: () => void newBookmark() }, 'New bookmark');
const editButton = h('button', { id: 'edit-selected', type: 'button', onclick: () => editSelected() }, 'Edit');
const deleteButton = h('button', { id: 'delete-selected', type: 'button', class: 'danger', onclick: () => void deleteNodes(selection.selected) }, 'Delete');
const selectionCount = h('span', { id: 'selection-count', class: 'muted small', 'aria-live': 'polite' });
replace(toolbar, searchInput, newFolderButton, newBookmarkButton, editButton, deleteButton, selectionCount);

function editableSelection(): string | null {
  if (!tree || selection.selected.size !== 1) return null;
  const [id] = selection.selected;
  return id !== undefined && tree.nodes.has(id) && !isRootId(tree, id) ? id : null;
}

function editSelected(): void {
  const id = editableSelection();
  if (id) edit(id);
}

function updateToolbar(): void {
  const loaded = tree !== null;
  newFolderButton.disabled = !loaded;
  newBookmarkButton.disabled = !loaded;
  editButton.disabled = editableSelection() === null;
  deleteButton.disabled = !tree || normalizeSelection(tree, selection.selected).length === 0;
  selectionCount.textContent = selection.selected.size > 1 ? `${selection.selected.size} selected` : '';
}

// ---- events ---------------------------------------------------------------------

main.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement;
  const result = target.closest<HTMLElement>('[data-reveal]');
  if (result) {
    reveal(result.dataset.reveal!);
    return;
  }
  const toggler = target.closest<HTMLElement>('[data-toggle]');
  if (toggler) {
    toggle(toggler.dataset.toggle!);
    return;
  }
  const row = target.closest<HTMLElement>('.node-row');
  if (!row || !tree || !expanded) return;
  const id = row.dataset.id!;
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action === 'edit') return edit(id);
  if (action === 'delete') return void deleteNodes([id]);
  // On click, not mousedown: starting a drag must not collapse a multi-selection.
  selection = select(selection, id, { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey }, visibleOrder(tree, expanded));
  paintSelection();
});

main.addEventListener('dblclick', (ev) => {
  const target = ev.target as HTMLElement;
  const row = target.closest<HTMLElement>('.node-row');
  if (!row || target.closest('[data-toggle], [data-action]')) return;
  const n = tree?.nodes.get(row.dataset.id!);
  if (n?.kind === 'bookmark' && n.url) {
    void ext()
      .tabs.create({ url: n.url })
      .catch((e: unknown) => setMessage(`Cannot open ${n.url}: ${errorText(e)}`));
  } else if (n?.kind === 'folder') {
    if (target.closest('.title') && tree && !isRootId(tree, n.id)) startRename(n.id);
    else toggle(n.id);
  }
});

// ---- drag and drop ----------------------------------------------------------------

/** The nodes being dragged and the refresh hold kept for the whole drag. */
let drag: { ids: string[]; release: Release } | null = null;
let indicator: HTMLElement | null = null;

function clearIndicator(): void {
  indicator?.classList.remove('drop-before', 'drop-after', 'drop-inside');
  indicator = null;
}

/** Where a drop on the row under the pointer would land, or null when refused or a no-op. */
function dropAt(ev: DragEvent): { row: HTMLElement; zone: Zone; parentId: string; afterId: string | null } | null {
  const row = (ev.target as HTMLElement).closest<HTMLElement>('.node-row');
  if (!drag || !row || !tree || !expanded) return null;
  const rect = row.getBoundingClientRect();
  const zone = zoneAt(ev.clientY - rect.top, rect.height, row.dataset.kind === 'folder');
  const r = resolveDrop(tree, drag.ids, row.dataset.id!, zone, expanded);
  return 'parentId' in r ? { row, zone, parentId: r.parentId, afterId: r.afterId } : null;
}

main.addEventListener('dragstart', (ev) => {
  const row = (ev.target as HTMLElement).closest<HTMLElement>('.node-row');
  const id = row?.dataset.id;
  if (!row || !id || !tree || isRootId(tree, id) || !ev.dataTransfer) {
    ev.preventDefault();
    return;
  }
  const ids = selection.selected.has(id) ? [...selection.selected] : [id];
  // Firefox starts no drag without data.
  ev.dataTransfer.setData('text/plain', ids.join('\n'));
  ev.dataTransfer.effectAllowed = 'move';
  drag = { ids, release: gate.hold() };
  for (const d of ids) rowOf(d)?.classList.add('dragging');
});

main.addEventListener('dragover', (ev) => {
  const at = dropAt(ev);
  if (indicator && indicator !== at?.row) clearIndicator();
  if (!at) return; // not preventing default: the browser shows "no drop" here
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
  clearIndicator();
  indicator = at.row;
  indicator.classList.add(`drop-${at.zone}`);
});

main.addEventListener('dragleave', (ev) => {
  if (indicator && !indicator.contains(ev.relatedTarget as Node | null)) clearIndicator();
});

main.addEventListener('drop', (ev) => {
  ev.preventDefault(); // Firefox would otherwise navigate to the dragged text
  const at = dropAt(ev);
  clearIndicator();
  const t = tree;
  if (!at || !drag || !t) return;
  const ids = drag.ids;
  void run(async () => {
    const moved = await moveMany(bookmarks.adapter, t, ids, at.parentId, at.afterId);
    expanded?.add(at.parentId);
    selection = moved.length > 0 ? { selected: new Set(moved), anchor: moved[0]! } : selection;
  });
});

main.addEventListener('dragend', () => {
  clearIndicator();
  for (const el of main.querySelectorAll('.node-row.dragging')) el.classList.remove('dragging');
  drag?.release();
  drag = null;
});

updateToolbar();
bookmarks.onChange(() => gate.notify());
void load().then(() => {
  const target = new URLSearchParams(location.search).get('reveal');
  if (target) reveal(target);
});
