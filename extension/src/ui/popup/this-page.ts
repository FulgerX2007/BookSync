// "Bookmark this page": adds the active tab to a folder the user picks, and
// says where the page is already bookmarked. Lives outside the status
// container, so status re-renders never reset a half-filled form.
import type { LocalTree } from '../../browser/adapter';
import { createBookmark } from '../../bookmarks/ops';
import { folderOptions, pathOf } from '../../bookmarks/tree';
import { ROOT_OTHER } from '../../model/vault';
import { matchKey } from '../../model/url';
import { ext } from '../../platform/ext';
import type { Bookmarks } from '../shared/bookmarks';
import { h, replace } from '../shared/dom';
import { errorText } from '../shared/errors';

/**
 * The tab to bookmark. activeTab grants its URL once the toolbar popup is
 * open; e2e builds open popup.html in a tab of its own and name the target
 * tab with ?tab=<id> instead.
 */
async function currentTab(): Promise<chrome.tabs.Tab | undefined> {
  const forced = __BOOKSYNC_E2E__ ? new URLSearchParams(location.search).get('tab') : null;
  if (forced) return ext().tabs.get(Number(forced));
  const [tab] = await ext().tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Where a URL is already bookmarked, as folder paths. */
function existingPlaces(tree: LocalTree, url: string): string[] {
  const key = matchKey(url);
  const out: string[] = [];
  for (const n of tree.nodes.values()) {
    if (n.kind === 'bookmark' && n.url !== undefined && matchKey(n.url) === key) out.push(pathOf(tree, n.id).join(' › '));
  }
  return out;
}

export function mountThisPage(container: HTMLElement, bookmarks: Bookmarks): void {
  const button = h('button', { id: 'bookmark-page', type: 'button', disabled: true }, '★ Bookmark this page');
  const hint = h('div', { id: 'this-page-hint', class: 'muted small' });
  const title = h('input', { id: 'page-title', type: 'text', autocomplete: 'off' });
  const folder = h('select', { id: 'page-folder' });
  const error = h('div', { id: 'this-page-error', class: 'error', role: 'alert' });
  const save = h('button', { id: 'page-save', type: 'submit', class: 'primary' }, 'Save');
  const form = h(
    'form',
    { id: 'this-page-form', hidden: true },
    h('label', { for: 'page-title' }, 'Name'),
    title,
    h('label', { for: 'page-folder' }, 'Folder'),
    folder,
    h('div', { class: 'row' }, save, h('button', { id: 'page-cancel', type: 'button', onclick: () => (form.hidden = true) }, 'Cancel')),
  );
  replace(container, button, hint, form, error);

  let tab: chrome.tabs.Tab | undefined;
  let tree: LocalTree | null = null;

  const showPlaces = () => {
    if (!tree || !tab?.url) return;
    const places = existingPlaces(tree, tab.url);
    hint.textContent = places.length > 0 ? `Already bookmarked in ${places.join('; ')}` : '';
  };

  const loadTree = async () => {
    tree = await bookmarks.load();
    showPlaces();
    return tree;
  };

  button.addEventListener('click', async () => {
    error.textContent = '';
    try {
      const t = await loadTree();
      const options = folderOptions(t);
      const selected = folder.value || t.roots[ROOT_OTHER] || options[0]?.id;
      replace(folder, ...options.map((o) => h('option', { value: o.id, selected: o.id === selected }, o.label)));
      title.value = tab?.title ?? '';
      form.hidden = false;
      title.focus();
      title.select();
    } catch (e) {
      error.textContent = errorText(e);
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!tab?.url || !tree) return;
    save.disabled = true;
    error.textContent = '';
    try {
      await createBookmark(bookmarks.adapter, tree, folder.value, 'end', { title: title.value.trim() || tab.url, url: tab.url });
      form.hidden = true;
      await loadTree();
    } catch (e) {
      error.textContent = errorText(e);
      await loadTree().catch(() => undefined);
    } finally {
      save.disabled = false;
    }
  });

  void (async () => {
    try {
      tab = await currentTab();
      if (tab?.url) {
        button.disabled = false;
        await loadTree();
      } else {
        button.title = 'This page cannot be bookmarked.';
      }
    } catch (e) {
      error.textContent = errorText(e);
    }
  })();
}
