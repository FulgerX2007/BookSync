// Background entry point: service worker on Chromium, event page on Firefox.
//
// Both branches register their listeners synchronously, in the first turn of
// the event loop (see app.ts).
import { ext, hasBookmarksApi } from '../platform/ext';
import { startBackground } from './app';
import { Router } from './router';

if (hasBookmarksApi()) {
  startBackground(ext());
} else {
  // Firefox for Android has no bookmarks API, so nothing can sync here. Still
  // answer the pages, so they can say why instead of waiting forever.
  const router = new Router();
  router.refuseAll('unsupported_browser', 'this browser has no bookmarks API for extensions');
  router.listen(ext().runtime);
}
