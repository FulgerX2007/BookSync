// The emergency kit: what a person needs, besides their password, to sign in
// on a new browser. Never contains the password.
import { formatSyncId } from '../crypto/syncid';
import type { EmergencyKit } from './messages';

export interface KitInput {
  serverUrl: string;
  username: string;
  syncId: Uint8Array;
  createdAt: number;
}

export function emergencyKit({ serverUrl, username, syncId, createdAt }: KitInput): EmergencyKit {
  const id = formatSyncId(syncId);
  const date = new Date(createdAt).toISOString().slice(0, 10);
  const text = [
    'BookSync Emergency Kit',
    '======================',
    '',
    'Keep this somewhere safe: print it, or store it in your password manager.',
    'You need it, together with your password, to sign in on another browser.',
    '',
    `Server:    ${serverUrl}`,
    `Username:  ${username}`,
    `SyncID:    ${id}`,
    `Created:   ${date}`,
    '',
    'Your password is not in this kit. Your bookmarks are encrypted with keys',
    'derived from the password AND the SyncID. Nobody can reset them, not even the',
    'server operator: if you lose either one, the synced copy cannot be recovered',
    '(the bookmarks in your browsers stay where they are).',
    '',
  ].join('\n');
  return { text, syncId: id, fileName: `booksync-emergency-kit-${username}.txt` };
}
