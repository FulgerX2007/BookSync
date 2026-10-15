// Popup search: find a bookmark by any part of its title or URL and open it.
// Built once into its own container; status re-renders never touch it.
import { createRefreshGate } from '../../bookmarks/refresh';
import { createSearchIndex, search, type SearchIndex, type SearchResult } from '../../bookmarks/search';
import { ext } from '../../platform/ext';
import type { Bookmarks } from '../shared/bookmarks';
import { h, replace } from '../shared/dom';
import { errorText } from '../shared/errors';

const LIMIT = 50;

function host(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function mountSearch(container: HTMLElement, bookmarks: Bookmarks): void {
  let index: SearchIndex | null = null;
  let results: SearchResult[] = [];
  let active = 0;

  const input = h('input', {
    type: 'search',
    id: 'popup-search',
    placeholder: 'Search bookmarks',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Search bookmarks',
    'aria-controls': 'popup-results',
  });
  const list = h('ul', { id: 'popup-results', class: 'results', role: 'listbox', 'aria-label': 'Matching bookmarks' });
  const note = h('div', { id: 'popup-search-note', class: 'muted small' });
  const error = h('div', { id: 'popup-search-error', class: 'error', role: 'alert' });
  replace(container, input, list, note, error);

  const open = async (r: SearchResult | undefined) => {
    if (!r?.url) return;
    error.textContent = '';
    try {
      await ext().tabs.create({ url: r.url });
      window.close();
    } catch (e) {
      error.textContent = `Cannot open ${r.url}: ${errorText(e)}`;
    }
  };

  const render = () => {
    const query = input.value;
    results = index && query.trim() ? search(index, query, { limit: LIMIT, kinds: ['bookmark'] }) : [];
    active = Math.min(active, Math.max(results.length - 1, 0));
    replace(
      list,
      ...results.map((r, i) =>
        h(
          'li',
          {
            id: `popup-result-${i}`,
            class: 'result',
            role: 'option',
            'aria-selected': String(i === active),
            title: `${r.title}\n${r.url ?? ''}`,
            onclick: () => void open(r),
          },
          h('div', { class: 'result-title' }, r.title || r.url || ''),
          h('div', { class: 'result-meta muted' }, [host(r.url), r.path.join(' › ')].filter(Boolean).join(' · ')),
        ),
      ),
    );
    note.textContent = query.trim() && index && results.length === 0 ? 'No bookmarks match.' : '';
    if (results.length > 0) input.setAttribute('aria-activedescendant', `popup-result-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  const move = (delta: number) => {
    if (results.length === 0) return;
    active = (active + delta + results.length) % results.length;
    render();
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => {
    active = 0;
    render();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      move(ev.key === 'ArrowDown' ? 1 : -1);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      void open(results[active]);
    } else if (ev.key === 'Escape' && input.value !== '') {
      ev.preventDefault();
      input.value = '';
      active = 0;
      render();
    }
  });

  const load = async () => {
    try {
      index = createSearchIndex(await bookmarks.load());
      error.textContent = '';
    } catch (e) {
      index = null;
      error.textContent = errorText(e);
    }
    render();
  };
  const gate = createRefreshGate({ refresh: load });
  bookmarks.onChange(() => gate.notify());
  void load();
  input.focus();
}
