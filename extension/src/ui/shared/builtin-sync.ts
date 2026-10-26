// Where each browser keeps its own bookmark sync. Running it next to BookSync
// makes the two fight: deleted bookmarks come back and others get duplicated.
// Only Chrome's account storage can be detected (native_sync_detected); for
// every other browser the pages show these steps until the user confirms.
import { detectBrowser, type BrowserName } from './device-name';

export interface BuiltinSyncHelp {
  /** "Edge's", or "your browser's" when unknown. */
  owner: string;
  /** The account behind that sync, for the explanation. */
  account: string;
  /** A settings address to paste into the address bar, if the browser has a stable one. */
  address: string | null;
  /** What to switch off there. */
  step: string;
}

export function builtinSyncHelp(browser: BrowserName): BuiltinSyncHelp {
  switch (browser) {
    case 'Chrome':
      return { owner: 'Chrome’s', account: 'Google account', address: 'chrome://settings/syncSetup/advanced', step: 'Turn off Bookmarks.' };
    case 'Edge':
      return { owner: 'Edge’s', account: 'Microsoft account', address: 'edge://settings/profiles/sync', step: 'Turn off Favorites.' };
    case 'Brave':
      return { owner: 'Brave’s', account: 'Brave Sync chain', address: 'brave://settings/braveSync/setup', step: 'Under Sync settings, turn off Bookmarks.' };
    case 'Firefox':
      return { owner: 'Firefox’s', account: 'Mozilla account', address: 'about:preferences#sync', step: 'Choose Change, untick Bookmarks and save.' };
    case 'Opera':
      return { owner: 'Opera’s', account: 'Opera account', address: null, step: 'Open Settings → Sync and turn off Bookmarks.' };
    case 'Vivaldi':
      return { owner: 'Vivaldi’s', account: 'Vivaldi account', address: null, step: 'Open Settings → Sync and untick Bookmarks.' };
    case 'Browser':
      return { owner: 'your browser’s', account: 'browser account', address: null, step: 'Open its sync settings and turn off bookmark sync.' };
  }
}

/** The steps for the browser this page runs in. */
export function thisBrowserSyncHelp(): BuiltinSyncHelp {
  return builtinSyncHelp(detectBrowser(navigator.userAgent, 'brave' in navigator));
}
