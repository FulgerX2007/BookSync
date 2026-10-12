// Bookmark manager support in the background. The popup and the manager ask
// which native folders are the synced roots, so they show exactly what sync
// syncs: the pinned roots, verified, plus a Chromium menu folder that sync
// has not pinned yet (it would otherwise read as an ordinary folder).
import type { BookmarksAdapter } from '../browser/adapter';
import type { StateStore } from '../storage/state';
import { RequestError, type Router } from './router';

export interface BookmarkHandlerDeps {
  adapter: Pick<BookmarksAdapter, 'resolveRoots'>;
  state: Pick<StateStore, 'getSync'>;
}

export function registerBookmarkHandlers(router: Router, { adapter, state }: BookmarkHandlerDeps): void {
  router.register('bookmarkRoots', async () => {
    // resolveRoots only reads the browser; nothing here writes sync state.
    const r = await adapter.resolveRoots((await state.getSync()).rootPins);
    if (r.status === 'roots_changed') {
      throw new RequestError('roots_changed', 'Some bookmark folders BookSync syncs are gone. Re-pin them in the BookSync settings.');
    }
    return r.pins;
  });
}
