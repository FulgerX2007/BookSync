// What every extension page shows in a browser without the bookmarks API
// (Firefox for Android), where BookSync can't run. Pages check
// hasBookmarksApi() before touching bookmarks or the background.
import { h } from './dom';

const ANDROID_APP_URL = 'https://github.com/FulgerX2007/BookSync#android-app';

export function unsupportedNotice(): HTMLElement {
  return h(
    'section',
    { class: 'card warn', id: 'unsupported-browser' },
    h('h2', {}, 'BookSync can’t run in this browser'),
    h('p', {}, 'This browser doesn’t let extensions read or change bookmarks. Firefox for Android is one of them.'),
    h(
      'p',
      {},
      'On Android, use the ',
      h('a', { href: ANDROID_APP_URL, target: '_blank', rel: 'noopener' }, 'BookSync app'),
      ' instead. It keeps your bookmarks on the phone and syncs them with your other browsers.',
    ),
  );
}

/** Replaces a page's "Loading…" when it fails to start, instead of leaving it there. */
export function startFailure(text: string): HTMLElement {
  return h('p', { class: 'error', role: 'alert', id: 'start-error' }, `BookSync could not start: ${text}`);
}
