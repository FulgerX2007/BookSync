// Toolbar popup: bookmark search on top, then the sync status at a glance and
// the actions it may need. Status re-renders only touch #status-app.
import type { MessageType, StatusView } from '../../background/messages';
import { ext } from '../../platform/ext';
import { openBookmarks } from '../shared/bookmarks';
import { byId, h, replace, timeAgo } from '../shared/dom';
import { errorText } from '../shared/errors';
import { onStatus, send } from '../shared/rpc';
import { mountSearch } from './search';
import { mountThisPage } from './this-page';

const app = byId('status-app');
let status: StatusView;

type Tone = 'ok' | 'warn' | 'bad' | '';

function openSettings(): void {
  void ext().runtime.openOptionsPage();
  window.close();
}

function action(id: string, label: string, type: MessageType, cls = ''): HTMLButtonElement {
  return h(
    'button',
    {
      id,
      class: cls,
      onclick: async (ev: Event) => {
        const button = ev.currentTarget as HTMLButtonElement;
        button.disabled = true;
        byId('popup-error').textContent = '';
        try {
          status = (await send(type as 'syncNow')) as StatusView;
          render();
        } catch (e) {
          byId('popup-error').textContent = errorText(e);
        } finally {
          button.disabled = false;
        }
      },
    },
    label,
  );
}

function view(): { tone: Tone; text: string; detail?: string; buttons: HTMLElement[] } {
  const settings = h('button', { id: 'open-settings', onclick: openSettings }, 'Open settings');
  if (!status.signedIn) {
    return status.needsReLogin
      ? { tone: 'bad', text: 'Signed out by the server', detail: 'Sign in again to resume syncing.', buttons: [settings] }
      : { tone: '', text: 'Not set up yet', detail: 'Connect BookSync to your server to start syncing.', buttons: [settings] };
  }
  if (status.paused) return { tone: 'warn', text: 'Paused', buttons: [action('resume', 'Resume', 'resumeSync', 'primary')] };
  const p = status.pendingConfirmation;
  switch (status.status) {
    case 'ok':
    case 'never':
      return { tone: 'ok', text: status.lastSyncAt ? 'Up to date' : 'Not synced yet', detail: `Last synced ${timeAgo(status.lastSyncAt)}`, buttons: [action('sync-now', 'Sync now', 'syncNow', 'primary'), action('pause', 'Pause', 'pauseSync')] };
    case 'syncing':
      return { tone: '', text: 'Syncing…', buttons: [action('pause', 'Pause', 'pauseSync')] };
    case 'error':
    case 'conflict_exhausted':
      return { tone: 'bad', text: 'Sync failed', detail: status.lastError ?? 'Will retry automatically.', buttons: [action('retry', 'Retry now', 'syncNow', 'primary')] };
    case 'needs_confirmation':
      return {
        tone: 'warn',
        text: 'Confirm a large deletion',
        detail: `This sync would delete ${p?.deletionsToLocal ?? 0} bookmark(s) here and ${p?.deletionsToRemote ?? 0} on the server.`,
        buttons: [action('confirm', 'Confirm', 'confirmPendingSync', 'danger'), action('pause-instead', 'Pause sync', 'pauseSync')],
      };
    case 'rollback_detected':
      return {
        tone: 'warn',
        text: 'Server copy is older than this browser',
        detail: 'Usually the server was restored from a backup. Keep which version?',
        buttons: [action('use-local', 'This browser’s', 'useLocalVersion', 'primary'), action('accept-remote', 'Server’s', 'acceptServerVersion')],
      };
    case 'native_sync_detected':
      return { tone: 'warn', text: 'Paused: browser sync is on', detail: 'Review the warning in settings.', buttons: [settings] };
    case 'roots_changed':
      return { tone: 'warn', text: 'Bookmark folders changed', detail: 'Re-pin the folders in settings.', buttons: [settings] };
    default:
      return { tone: '', text: status.status, buttons: [settings] };
  }
}

function render(): void {
  const v = view();
  replace(
    app,
    h('div', { class: 'top' }, h('h1', {}, 'BookSync'), status.username && h('span', { class: 'muted' }, status.username)),
    h('div', { class: 'status' }, h('span', { class: `dot ${v.tone}` }), h('div', {}, h('div', { id: 'popup-status' }, h('strong', {}, v.text)), v.detail && h('div', { class: 'muted', id: 'popup-detail' }, v.detail))),
    h('div', { class: 'row' }, ...v.buttons),
    h('div', { id: 'popup-error', class: 'error', role: 'alert' }),
    status.signedIn && h('a', { href: '#', class: 'settings', onclick: (ev: Event) => (ev.preventDefault(), openSettings()) }, 'Settings'),
  );
}

function openManager(): void {
  void ext().tabs.create({ url: ext().runtime.getURL('manager.html') });
  window.close();
}

async function main(): Promise<void> {
  byId('open-manager').addEventListener('click', openManager);
  const bookmarks = openBookmarks();
  mountSearch(byId('search'), bookmarks);
  mountThisPage(byId('this-page'), bookmarks);
  status = await send('getStatus');
  render();
  onStatus((s) => {
    status = s;
    render();
  });
}

void main();
