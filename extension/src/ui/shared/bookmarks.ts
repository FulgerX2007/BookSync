// The extension pages' access to the browser's bookmarks: the same adapter
// and roots as sync, with the roots re-resolved on every load (they change
// when the user signs in or out, or a menu folder appears).
import type { BookmarksAdapter, LocalTree, NativeBookmarksApi } from '../../browser/adapter';
import { ChromiumAdapter } from '../../browser/chromium';
import { FirefoxAdapter } from '../../browser/firefox';
import { ext } from '../../platform/ext';
import { send } from './rpc';

export interface Bookmarks {
  adapter: BookmarksAdapter;
  /** Reads the synced roots and everything under them. */
  load(): Promise<LocalTree>;
  /** Calls cb on every bookmark change (feed it to a refresh gate). */
  onChange(cb: () => void): void;
}

export function openBookmarks(): Bookmarks {
  const api = ext().bookmarks as unknown as NativeBookmarksApi;
  const adapter = __BOOKSYNC_TARGET__ === 'chromium' ? new ChromiumAdapter(api) : new FirefoxAdapter(api);
  return {
    adapter,
    load: async () => adapter.readTree(await send('bookmarkRoots')),
    onChange: (cb) => {
      for (const ev of adapter.changeEvents()) ev.addListener(cb);
    },
  };
}
