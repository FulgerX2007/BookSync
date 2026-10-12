// Bookmark manager: the synced bookmarks as a tree, refreshed live when sync
// or the browser changes them, with create / rename / edit / delete. All
// decisions live in src/bookmarks; this page only renders and wires events.
// Anything that edits holds the refresh gate, so a refresh never destroys
// an inline rename, an open dialog or one of our own multi-step operations.
import type { LocalTree } from '../../browser/adapter';
import { createBookmark, createFolder, deleteMany, rename, setUrl, type Position } from '../../bookmarks/ops';
import { createRefreshGate } from '../../bookmarks/refresh';
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

function render(): void {
  if (!tree) return;
  const scroller = document.scrollingElement;
  const top = scroller?.scrollTop ?? 0;
  const t = tree;
  replace(main, h('ul', { class: 'tree', id: 'tree' }, ...rootIds(t).map((id) => nodeItem(t, id))));
  if (scroller) scroller.scrollTop = top;
  updateToolbar();
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

const newFolderButton = h('button', { id: 'new-folder', type: 'button', onclick: () => void newFolder() }, 'New folder');
const newBookmarkButton = h('button', { id: 'new-bookmark', type: 'button', onclick: () => void newBookmark() }, 'New bookmark');
const editButton = h('button', { id: 'edit-selected', type: 'button', onclick: () => editSelected() }, 'Edit');
const deleteButton = h('button', { id: 'delete-selected', type: 'button', class: 'danger', onclick: () => void deleteNodes(selection.selected) }, 'Delete');
replace(toolbar, newFolderButton, newBookmarkButton, editButton, deleteButton);

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
}

// ---- events ---------------------------------------------------------------------

main.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement;
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
  selection = select(selection, id, {}, visibleOrder(tree, expanded));
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

updateToolbar();
bookmarks.onChange(() => gate.notify());
void load();
