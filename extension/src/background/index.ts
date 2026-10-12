// Background entry point: service worker on Chromium, event page on Firefox.
//
// Everything is constructed synchronously and every listener is registered
// in the first turn of the event loop: an MV3 worker woken by an event only
// receives it if its listener exists before the first await.
import { HttpApiClient, type ApiClient } from '../api/client';
import type { NativeBookmarksApi } from '../browser/adapter';
import { ChromiumAdapter } from '../browser/chromium';
import { FirefoxAdapter } from '../browser/firefox';
import { ext } from '../platform/ext';
import { StateStore } from '../storage/state';
import { syncOnce } from '../sync/engine';
import { restoreVersion } from '../sync/restore';
import { Account, registerAccountHandlers } from './account';
import { badgeFor } from './badge';
import { registerBookmarkHandlers } from './bookmarks';
import { RequestError, Router } from './router';
import { SyncScheduler, registerSyncHandlers, statusView } from './scheduler';

const api = ext();
const state = StateStore.lazy();
const bookmarks = api.bookmarks as unknown as NativeBookmarksApi;
const adapter = __BOOKSYNC_TARGET__ === 'chromium' ? new ChromiumAdapter(bookmarks) : new FirefoxAdapter(bookmarks);

/** A client for the signed-in server; the token is read fresh for every request. */
export async function serverClient(): Promise<ApiClient | null> {
  const session = await state.getSession();
  if (!session) return null;
  return new HttpApiClient(session.serverUrl, async () => (await state.getSession())?.deviceToken ?? null);
}

async function publishStatus(): Promise<void> {
  const view = await statusView(state);
  await api.storage.session.set({ status: view });
  const badge = badgeFor(view);
  await api.action.setBadgeText({ text: badge.text });
  await api.action.setBadgeBackgroundColor({ color: badge.color });
}

const scheduler: SyncScheduler = new SyncScheduler({
  sync: async (opts) => {
    const client = await serverClient();
    if (!client) return { status: 'signed_out' };
    return syncOnce({ api: client, adapter, state, now: Date.now, eventCount: scheduler.eventCount }, opts);
  },
  state,
  changeEvents: adapter.changeEvents(),
  importEvents: adapter.importEvents(),
  alarms: api.alarms,
  publish: publishStatus,
  now: Date.now,
});

const account = new Account({
  state,
  clientFor: (serverUrl, token) => new HttpApiClient(serverUrl, token),
  sync: (opts) => scheduler.requestSync(opts),
  now: Date.now,
  publish: publishStatus,
});

const router = new Router();
registerSyncHandlers(router, scheduler, state);
registerAccountHandlers(router, account);
registerBookmarkHandlers(router, { adapter, state });
router.register('listVersions', async () => {
  const client = await serverClient();
  if (!client) throw new RequestError('not_signed_in', 'this browser is not signed in');
  return client.listVersions();
});
router.register('restoreVersion', async (req) => {
  const client = await serverClient();
  if (!client) throw new RequestError('not_signed_in', 'this browser is not signed in');
  if (!Number.isSafeInteger(req.version) || req.version < 1) throw new RequestError('invalid_request', 'version must be a positive integer');
  await restoreVersion({ api: client, state, now: Date.now, sync: (opts) => scheduler.requestSync(opts) }, req.version);
  return statusView(state);
});
router.listen(api.runtime);

void scheduler.start();
api.runtime.onStartup.addListener(() => void scheduler.requestSync());
api.runtime.onInstalled.addListener(() => {
  void scheduler.ensureAlarm();
  void publishStatus();
});

export { account, adapter, router, scheduler, state };
