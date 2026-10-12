// Options page: connect to a server, create an account or sign in, and
// manage the account (devices, password, emergency kit, deletion).
import type { EmergencyKit, StatusView } from '../../background/messages';
import { normalizeServerUrl } from '../../api/client';
import { parseSyncId } from '../../crypto/syncid';
import { ext } from '../../platform/ext';
import { defaultDeviceName } from '../shared/device-name';
import { byId, download, h, replace, timeAgo, value } from '../shared/dom';
import { errorText } from '../shared/errors';
import { onStatus, send } from '../shared/rpc';

const app = byId('app');
const LAST_SERVER_KEY = 'booksync.lastServer';

let status: StatusView;
/** A freshly shown emergency kit blocks everything else until confirmed. */
let shownKit: EmergencyKit | null = null;
let connectedServer: string | null = null;
let authTab: 'register' | 'login' = 'login';

function rememberedServer(): string {
  try {
    return localStorage.getItem(LAST_SERVER_KEY) ?? '';
  } catch {
    return '';
  }
}

function deviceName(): string {
  return defaultDeviceName(navigator.userAgent, 'brave' in navigator);
}

/** Runs an action with the button disabled and errors shown in `errorId`. */
async function busy(button: HTMLButtonElement, errorId: string, fn: () => Promise<void>): Promise<void> {
  const err = byId(errorId);
  err.textContent = '';
  button.disabled = true;
  try {
    await fn();
  } catch (e) {
    err.textContent = errorText(e);
  } finally {
    button.disabled = false;
  }
}

function render(): void {
  if (shownKit) return renderKit(shownKit);
  if (!status.signedIn) return renderSignedOut();
  renderSignedIn();
}

// ---- signed out --------------------------------------------------------------

function renderSignedOut(): void {
  const server = connectedServer ?? status.serverUrl ?? rememberedServer();
  if (!connectedServer && !status.needsReLogin) {
    replace(
      app,
      h(
        'section',
        { class: 'card' },
        h('h2', {}, 'Connect to your server'),
        h('p', { class: 'muted' }, 'Enter the address of your BookSync server.'),
        h('label', { for: 'server-url' }, 'Server address'),
        h('input', { id: 'server-url', type: 'url', placeholder: 'https://booksync.example.com', value: server, autocomplete: 'url' }),
        h('div', { class: 'row' }, h('button', { id: 'connect', class: 'primary', onclick: onConnect }, 'Continue')),
        h('div', { id: 'connect-error', class: 'error', role: 'alert' }),
      ),
    );
    return;
  }
  connectedServer = connectedServer ?? status.serverUrl;
  if (status.needsReLogin) authTab = 'login';
  replace(
    app,
    h(
      'section',
      { class: 'card' },
      status.needsReLogin && h('p', { class: 'muted', id: 'relogin-note' }, 'The server signed this browser out. Sign in again to resume syncing.'),
      h('p', { class: 'muted' }, 'Server: ', h('span', { class: 'mono', id: 'connected-server' }, connectedServer ?? ''), ' ', h('a', { href: '#', id: 'change-server', onclick: onChangeServer }, 'change')),
      h(
        'div',
        { class: 'tabs', role: 'tablist' },
        h('button', { id: 'tab-login', role: 'tab', 'aria-selected': String(authTab === 'login'), onclick: () => switchTab('login') }, 'Sign in'),
        !status.needsReLogin && h('button', { id: 'tab-register', role: 'tab', 'aria-selected': String(authTab === 'register'), onclick: () => switchTab('register') }, 'Create account'),
      ),
      authTab === 'login' ? loginForm() : registerForm(),
    ),
  );
  if (authTab === 'login' && status.needsReLogin) void prefillSyncId();
}

function switchTab(tab: 'register' | 'login'): void {
  authTab = tab;
  render();
}

function onChangeServer(ev: Event): void {
  ev.preventDefault();
  connectedServer = null;
  render();
}

function onConnect(ev: Event): void {
  const button = ev.currentTarget as HTMLButtonElement;
  const err = byId('connect-error');
  err.textContent = '';
  let url: string;
  try {
    url = normalizeServerUrl(value('server-url'));
  } catch (e) {
    err.textContent = errorText(e);
    return;
  }
  // Must run synchronously inside the click: Firefox drops the user gesture after an await.
  const u = new URL(url);
  const granted = ext().permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
  void busy(button, 'connect-error', async () => {
    if (!(await granted)) throw new Error('BookSync needs permission to talk to this server.');
    const res = await fetch(`${url}/healthz`, { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) throw new Error('No BookSync server answered at that address.');
    try {
      localStorage.setItem(LAST_SERVER_KEY, url);
    } catch {
      // Per-viewer convenience only.
    }
    connectedServer = url;
    render();
  });
}

function registerForm(): HTMLElement {
  return h(
    'form',
    { id: 'register-form', onsubmit: onRegister },
    h('label', { for: 'reg-username' }, 'Username'),
    h('input', { id: 'reg-username', type: 'text', autocomplete: 'username', required: true }),
    h('label', { for: 'reg-password' }, 'Password'),
    h('input', { id: 'reg-password', type: 'password', autocomplete: 'new-password', minlength: 10, required: true }),
    h('label', { for: 'reg-password2' }, 'Repeat password'),
    h('input', { id: 'reg-password2', type: 'password', autocomplete: 'new-password', required: true }),
    h('label', { for: 'reg-device' }, 'Name of this browser'),
    h('input', { id: 'reg-device', type: 'text', value: deviceName() }),
    h('p', { class: 'hint muted' }, 'Your password never leaves this browser. It cannot be reset — not even by the server operator.'),
    h('div', { class: 'row' }, h('button', { id: 'reg-submit', class: 'primary', type: 'submit' }, 'Create account')),
    h('div', { id: 'reg-error', class: 'error', role: 'alert' }),
  );
}

function onRegister(ev: Event): void {
  ev.preventDefault();
  void busy(byId<HTMLButtonElement>('reg-submit'), 'reg-error', async () => {
    if (value('reg-password') !== value('reg-password2')) throw new Error('The passwords do not match.');
    shownKit = await send('register', {
      serverUrl: connectedServer!,
      username: value('reg-username'),
      password: value('reg-password'),
      deviceName: value('reg-device') || deviceName(),
    });
    status = await send('getStatus');
    render();
  });
}

function loginForm(): HTMLElement {
  return h(
    'form',
    { id: 'login-form', onsubmit: onLogin },
    h('label', { for: 'login-username' }, 'Username'),
    h('input', { id: 'login-username', type: 'text', autocomplete: 'username', value: status.username ?? '', required: true }),
    h('label', { for: 'login-password' }, 'Password'),
    h('input', { id: 'login-password', type: 'password', autocomplete: 'current-password', required: true }),
    h('label', { for: 'login-syncid' }, 'SyncID'),
    h('input', { id: 'login-syncid', type: 'text', placeholder: 'BS1-XXXX-XXXX-…', class: 'mono', autocomplete: 'off', spellcheck: 'false', oninput: checkSyncId, required: true }),
    h('div', { id: 'login-syncid-hint', class: 'hint muted' }, 'From your emergency kit.'),
    h('label', { for: 'login-device' }, 'Name of this browser'),
    h('input', { id: 'login-device', type: 'text', value: deviceName() }),
    h('div', { class: 'row' }, h('button', { id: 'login-submit', class: 'primary', type: 'submit' }, 'Sign in')),
    h('div', { id: 'login-error', class: 'error', role: 'alert' }),
  );
}

function checkSyncId(): void {
  const hint = byId('login-syncid-hint');
  const raw = value('login-syncid');
  if (raw.replace(/[\s-]/g, '').length < 10) {
    hint.className = 'hint muted';
    hint.textContent = 'From your emergency kit.';
    return;
  }
  try {
    parseSyncId(raw);
    hint.className = 'hint ok';
    hint.textContent = 'Looks right.';
  } catch (e) {
    hint.className = 'hint bad';
    hint.textContent = (e as { code?: string }).code === 'invalid_checksum' ? 'This SyncID has a typo.' : 'Not a complete SyncID yet.';
  }
}

async function prefillSyncId(): Promise<void> {
  try {
    const kit = await send('getEmergencyKit');
    const input = byId<HTMLInputElement>('login-syncid');
    if (!input.value) {
      input.value = kit.syncId;
      checkSyncId();
    }
  } catch {
    // No local session: nothing to prefill.
  }
}

function onLogin(ev: Event): void {
  ev.preventDefault();
  void busy(byId<HTMLButtonElement>('login-submit'), 'login-error', async () => {
    status = await send('login', {
      serverUrl: connectedServer ?? status.serverUrl!,
      username: value('login-username'),
      password: value('login-password'),
      syncId: value('login-syncid'),
      deviceName: value('login-device') || deviceName(),
    });
    render();
  });
}

// ---- emergency kit -------------------------------------------------------------

function renderKit(kit: EmergencyKit): void {
  replace(
    app,
    h(
      'section',
      { class: 'card warn', id: 'kit' },
      h('h2', {}, 'Save your SyncID'),
      h('p', {}, 'You need this SyncID and your password to sign in on any other browser. BookSync cannot show it to anyone else or recover it.'),
      h('div', { class: 'syncid', id: 'kit-syncid' }, kit.syncId),
      h('div', { class: 'row' }, h('button', { id: 'kit-download', onclick: () => download(kit.fileName, kit.text) }, 'Download emergency kit')),
      h(
        'label',
        { class: 'check' },
        h('input', { id: 'kit-saved', type: 'checkbox', onchange: () => (byId<HTMLButtonElement>('kit-continue').disabled = !byId<HTMLInputElement>('kit-saved').checked) }),
        h('span', {}, 'I have saved my SyncID somewhere safe.'),
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            id: 'kit-continue',
            class: 'primary',
            disabled: true,
            onclick: () => {
              shownKit = null;
              render();
            },
          },
          'Continue',
        ),
      ),
    ),
  );
}

// ---- signed in ---------------------------------------------------------------

const STATUS_TEXT: Record<string, string> = {
  never: 'Not synced yet',
  syncing: 'Syncing…',
  ok: 'Up to date',
  paused: 'Paused',
  signed_out: 'Signed out',
  error: 'Sync failed',
  needs_confirmation: 'Waiting for your confirmation',
  conflict_exhausted: 'Busy — will retry',
  rollback_detected: 'Server data is older than expected',
  roots_changed: 'Bookmark folders changed',
  native_sync_detected: 'Paused: browser sync is on',
};

function renderSignedIn(): void {
  replace(
    app,
    h('section', { class: 'card', id: 'account' },
      h('h2', {}, 'Account'),
      h('p', {}, h('strong', { id: 'account-username' }, status.username ?? ''), h('span', { class: 'muted' }, ` on ${status.serverUrl ?? ''}`)),
      h('p', {}, 'Status: ', h('span', { id: 'status' }, statusLine())),
      h('div', { class: 'row' },
        h('button', { id: 'sync-now', onclick: (ev: Event) => void busy(ev.currentTarget as HTMLButtonElement, 'account-error', async () => void (status = await send('syncNow'))) }, 'Sync now'),
        h('button', { id: 'show-kit', onclick: onShowKit }, 'Show SyncID'),
      ),
      h('div', { id: 'account-error', class: 'error', role: 'alert' }),
      h('div', { id: 'kit-reveal' }),
    ),
    actionCard(),
    h('section', { class: 'card', id: 'devices-card' }, h('h2', {}, 'Devices'), h('ul', { class: 'devices', id: 'devices' }, h('li', { class: 'muted' }, 'Loading…')), h('div', { id: 'devices-error', class: 'error' })),
    h('section', { class: 'card', id: 'history-card' }),
    passwordCard(),
    h('section', { class: 'card danger' },
      h('h2', {}, 'Sign out or delete'),
      h('p', { class: 'muted' }, 'Signing out keeps your bookmarks in this browser and on the server.'),
      h('div', { class: 'row' }, h('button', { id: 'logout', onclick: onLogout }, 'Sign out')),
      h('h3', {}, 'Delete account'),
      h('p', { class: 'muted' }, 'Removes your account and every synced copy from the server. Bookmarks in your browsers stay.'),
      h('label', { for: 'delete-username' }, 'Type your username to confirm'),
      h('input', { id: 'delete-username', type: 'text', autocomplete: 'off' }),
      h('label', { for: 'delete-password' }, 'Password'),
      h('input', { id: 'delete-password', type: 'password', autocomplete: 'current-password' }),
      h('div', { class: 'row' }, h('button', { id: 'delete-submit', class: 'danger', onclick: onDelete }, 'Delete account')),
      h('div', { id: 'delete-error', class: 'error', role: 'alert' }),
    ),
  );
  void loadDevices();
  renderHistorySlot();
}

function statusLine(): string {
  const text = STATUS_TEXT[status.status] ?? status.status;
  return status.status === 'ok' ? `${text} (last synced ${timeAgo(status.lastSyncAt)})` : status.lastError && status.status === 'error' ? `${text}: ${status.lastError}` : text;
}

/** Explains states that need a decision, with the matching action. */
function actionCard(): HTMLElement | null {
  const act = (id: string, label: string, type: 'acknowledgeNativeSync' | 'rejoin' | 'useLocalVersion' | 'acceptServerVersion' | 'confirmPendingSync', cls = '') =>
    h('button', { id, class: cls, onclick: (ev: Event) => void busy(ev.currentTarget as HTMLButtonElement, 'action-error', async () => void ((status = await send(type)), render())) }, label);
  const card = (title: string, ...body: (HTMLElement | string)[]) =>
    h('section', { class: 'card warn', id: 'action' }, h('h2', {}, title), ...body, h('div', { id: 'action-error', class: 'error', role: 'alert' }));
  switch (status.status) {
    case 'native_sync_detected':
      return card(
        'This browser syncs bookmarks itself',
        h('p', {}, 'Bookmark sync is on in this browser’s own account settings. If two browsers signed in to the same browser account both run BookSync, every bookmark gets duplicated over and over.'),
        h('p', {}, 'Turn off the browser’s bookmark sync, or make sure BookSync runs in only one browser on that account.'),
        h('div', { class: 'row' }, act('native-ack', 'I understand — sync with BookSync', 'acknowledgeNativeSync', 'primary')),
      );
    case 'roots_changed':
      return card(
        'Your bookmark folders changed',
        h('p', {}, 'A bookmark folder BookSync was syncing disappeared (for example after signing in or out of the browser’s account). Re-pin the folders and join again; nothing will be deleted.'),
        h('div', { class: 'row' }, act('rejoin', 'Re-pin folders and rejoin', 'rejoin', 'primary')),
      );
    case 'rollback_detected':
      return card(
        'The server’s copy is older than this browser’s',
        h('p', {}, 'This usually means the server was restored from a backup. Choose which side to keep:'),
        h('div', { class: 'row' }, act('use-local', 'Use this browser’s bookmarks', 'useLocalVersion', 'primary'), act('accept-remote', 'Accept the server’s version', 'acceptServerVersion')),
      );
    case 'needs_confirmation': {
      const p = status.pendingConfirmation;
      return card(
        'Confirm a large deletion',
        h('p', { id: 'pending-summary' }, `This sync would delete ${p?.deletionsToLocal ?? 0} bookmark(s) in this browser and ${p?.deletionsToRemote ?? 0} on the server.`),
        h('div', { class: 'row' }, act('confirm-sync', 'Confirm', 'confirmPendingSync', 'danger')),
      );
    }
    default:
      return null;
  }
}

async function onShowKit(): Promise<void> {
  try {
    const kit = await send('getEmergencyKit');
    replace(byId('kit-reveal'), h('div', { class: 'syncid', id: 'shown-syncid' }, kit.syncId), h('div', { class: 'row' }, h('button', { onclick: () => download(kit.fileName, kit.text) }, 'Download emergency kit')));
  } catch (e) {
    byId('account-error').textContent = errorText(e);
  }
}

async function loadDevices(): Promise<void> {
  try {
    const devices = await send('listDevices');
    replace(
      byId('devices'),
      ...devices.map((d) =>
        h(
          'li',
          { 'data-device-id': d.id },
          h('span', {}, d.name, ' ', d.current ? h('span', { class: 'badge ok' }, 'this browser') : h('span', { class: 'muted' }, `· last seen ${timeAgo(Date.parse(d.lastSeenAt))}`)),
          !d.current && h('button', { class: 'revoke', onclick: (ev: Event) => void busy(ev.currentTarget as HTMLButtonElement, 'devices-error', async () => { await send('revokeDevice', { deviceId: d.id }); await loadDevices(); }) }, 'Sign out'),
        ),
      ),
    );
  } catch (e) {
    byId('devices-error').textContent = errorText(e);
  }
}

function passwordCard(): HTMLElement {
  return h(
    'section',
    { class: 'card', id: 'password-card' },
    h('h2', {}, 'Change password'),
    h('label', { for: 'pw-current' }, 'Current password'),
    h('input', { id: 'pw-current', type: 'password', autocomplete: 'current-password' }),
    h('label', { for: 'pw-new' }, 'New password'),
    h('input', { id: 'pw-new', type: 'password', autocomplete: 'new-password', minlength: 10 }),
    h('label', { for: 'pw-new2' }, 'Repeat new password'),
    h('input', { id: 'pw-new2', type: 'password', autocomplete: 'new-password' }),
    h('label', { class: 'check' }, h('input', { id: 'pw-rotate', type: 'checkbox' }), h('span', {}, 'A device was lost or stolen: also rotate the encryption keys and SyncID. You will get a new emergency kit.')),
    h('p', { class: 'hint muted' }, 'Other browsers are signed out and need the new password' + ' (and the new SyncID, if rotated).'),
    h('div', { class: 'row' }, h('button', { id: 'pw-submit', class: 'primary', onclick: onChangePassword }, 'Change password')),
    h('div', { id: 'pw-error', class: 'error', role: 'alert' }),
    h('div', { id: 'pw-done', class: 'hint ok' }),
  );
}

function onChangePassword(ev: Event): void {
  void busy(ev.currentTarget as HTMLButtonElement, 'pw-error', async () => {
    if (value('pw-new') !== value('pw-new2')) throw new Error('The new passwords do not match.');
    const { kit } = await send('changePassword', {
      currentPassword: value('pw-current'),
      newPassword: value('pw-new'),
      rotateKeys: byId<HTMLInputElement>('pw-rotate').checked,
    });
    if (kit) {
      shownKit = kit;
      render();
    } else {
      byId('pw-done').textContent = 'Password changed. Other browsers must sign in again.';
      for (const id of ['pw-current', 'pw-new', 'pw-new2']) byId<HTMLInputElement>(id).value = '';
    }
  });
}

function onLogout(ev: Event): void {
  void busy(ev.currentTarget as HTMLButtonElement, 'delete-error', async () => {
    status = await send('logout');
    connectedServer = null;
    render();
  });
}

function onDelete(ev: Event): void {
  void busy(ev.currentTarget as HTMLButtonElement, 'delete-error', async () => {
    if (value('delete-username').trim().toLowerCase() !== status.username) throw new Error('Type your username exactly to confirm.');
    status = await send('deleteAccount', { password: value('delete-password') });
    connectedServer = null;
    render();
  });
}

/** Server-side version history with restore. */
function renderHistorySlot(): void {
  const slot = byId('history-card');
  replace(
    slot,
    h('h2', {}, 'History'),
    h('p', { class: 'muted' }, 'The server keeps recent versions and one per day for a month. Restoring makes an old version current again on every browser. Versions from before a key rotation are not available.'),
    h('div', { id: 'history' }, h('p', { class: 'muted' }, 'Loading…')),
    h('div', { id: 'history-error', class: 'error', role: 'alert' }),
  );
  void loadHistory();
}

async function loadHistory(): Promise<void> {
  try {
    const versions = await send('listVersions');
    const rows = versions.map((v, i) =>
      h(
        'tr',
        { 'data-version': v.version },
        h('td', {}, String(v.version)),
        h('td', {}, new Date(v.createdAt).toLocaleString()),
        h('td', {}, v.deviceName || '—'),
        h('td', {}, `${Math.max(1, Math.round(v.size / 1024))} KB`),
        h('td', {}, i === 0 ? h('span', { class: 'badge ok' }, 'current') : h('button', { class: 'restore', onclick: (ev: Event) => askRestore(ev.currentTarget as HTMLButtonElement, v.version) }, 'Restore')),
      ),
    );
    replace(byId('history'), h('table', { class: 'history' }, h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Saved'), h('th', {}, 'By'), h('th', {}, 'Size'), h('th', {}))), h('tbody', {}, ...rows)));
  } catch (e) {
    byId('history-error').textContent = errorText(e);
  }
}

/** Inline confirmation instead of a native dialog. */
function askRestore(button: HTMLButtonElement, version: number): void {
  const cell = button.parentElement!;
  replace(
    cell,
    h('span', { class: 'muted' }, 'Restore? '),
    h(
      'button',
      {
        class: 'danger confirm-restore',
        onclick: (ev: Event) =>
          void busy(ev.currentTarget as HTMLButtonElement, 'history-error', async () => {
            status = await send('restoreVersion', { version });
            render();
          }),
      },
      'Yes, restore',
    ),
    ' ',
    h('button', { onclick: () => void loadHistory() }, 'Cancel'),
  );
}

async function main(): Promise<void> {
  status = await send('getStatus');
  render();
  onStatus((s) => {
    const signedInChanged = s.signedIn !== status.signedIn;
    const actionChanged = s.status !== status.status;
    status = s;
    if (shownKit) return;
    if (signedInChanged || (s.signedIn && actionChanged && !document.activeElement?.closest('form, #password-card'))) render();
    else if (s.signedIn) {
      const el = document.getElementById('status');
      if (el) el.textContent = statusLine();
    }
  });
}

void main();
