// Bookmark manager: the synced bookmarks as a tree, refreshed live when sync
// or the browser changes them. Decisions live in src/bookmarks; this page
// only renders and wires events.
import type { LocalTree } from '../../browser/adapter';
import { createRefreshGate } from '../../bookmarks/refresh';
import { emptySelection, pruneSelection, select, type Selection } from '../../bookmarks/selection';
import { rootIds, visibleOrder } from '../../bookmarks/tree';
import { ext } from '../../platform/ext';
import { openBookmarks } from '../shared/bookmarks';
import { byId, h, replace } from '../shared/dom';
import { errorText } from '../shared/errors';
import { RpcError } from '../shared/rpc';

const bookmarks = openBookmarks();
const main = byId('manager-main');
const notice = byId('manager-notice');

let tree: LocalTree | null = null;
/** Expanded folders; the roots start expanded. */
let expanded: Set<string> | null = null;
let selection: Selection = emptySelection;

function showNotice(text: string, ...extra: Node[]): void {
  replace(notice, h('span', {}, text), ...extra);
  notice.hidden = false;
}

function hideNotice(): void {
  notice.hidden = true;
  replace(notice);
}

const rowOf = (id: string) => main.querySelector<HTMLElement>(`.node-row[data-id="${CSS.escape(id)}"]`);

function nodeItem(t: LocalTree, id: string, isRoot: boolean): HTMLLIElement {
  const n = t.nodes.get(id)!;
  const folder = n.kind === 'folder';
  const open = folder && expanded!.has(id);
  const kids = n.children ?? [];
  const title = n.title || (folder ? 'Untitled folder' : (n.url ?? ''));
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
  );
  return h('li', { class: isRoot ? 'root' : '' }, row, open && kids.length > 0 ? h('ul', {}, ...kids.map((c) => nodeItem(t, c, false))) : null);
}

function render(): void {
  if (!tree) return;
  const scroller = document.scrollingElement;
  const top = scroller?.scrollTop ?? 0;
  const t = tree;
  replace(main, h('ul', { class: 'tree', id: 'tree' }, ...rootIds(t).map((id) => nodeItem(t, id, true))));
  if (scroller) scroller.scrollTop = top;
}

/** Repaints the selection without rebuilding the rows. */
function paintSelection(): void {
  for (const el of main.querySelectorAll('.node-row.selected')) el.classList.remove('selected');
  for (const id of selection.selected) rowOf(id)?.classList.add('selected');
}

function toggle(id: string): void {
  if (!expanded) return;
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  render();
}

async function openBookmark(url: string): Promise<void> {
  try {
    await ext().tabs.create({ url });
  } catch (e) {
    showNotice(`Cannot open ${url}: ${errorText(e)}`);
  }
}

async function load(): Promise<void> {
  try {
    const t = await bookmarks.load();
    tree = t;
    expanded = expanded ? new Set([...expanded].filter((id) => t.nodes.has(id))) : new Set(rootIds(t));
    selection = pruneSelection(selection, (id) => t.nodes.has(id));
    hideNotice();
    render();
  } catch (e) {
    if (e instanceof RpcError && e.code === 'roots_changed') {
      showNotice(errorText(e), h('button', { type: 'button', onclick: () => void ext().runtime.openOptionsPage() }, 'Open settings'));
    } else {
      showNotice(`Could not read your bookmarks: ${errorText(e)}`);
    }
  }
}

main.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement;
  const toggler = target.closest<HTMLElement>('[data-toggle]');
  if (toggler) {
    toggle(toggler.dataset.toggle!);
    return;
  }
  const row = target.closest<HTMLElement>('.node-row');
  if (!row || !tree || !expanded) return;
  selection = select(selection, row.dataset.id!, {}, visibleOrder(tree, expanded));
  paintSelection();
});

main.addEventListener('dblclick', (ev) => {
  const row = (ev.target as HTMLElement).closest<HTMLElement>('.node-row');
  if (!row || (ev.target as HTMLElement).closest('[data-toggle]')) return;
  const n = tree?.nodes.get(row.dataset.id!);
  if (n?.kind === 'bookmark' && n.url) void openBookmark(n.url);
  else if (n?.kind === 'folder') toggle(n.id);
});

const gate = createRefreshGate({ refresh: load });
bookmarks.onChange(() => gate.notify());
void load();
