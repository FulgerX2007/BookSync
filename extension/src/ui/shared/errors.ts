// User-facing text for error codes coming from the background.
import { RpcError } from './rpc';

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Username, password or SyncID is incorrect.',
  invalid_checksum: 'That SyncID has a typo. Check it against your emergency kit.',
  invalid_format: 'That does not look like a SyncID (BS1-XXXX-…).',
  invalid_username: 'Usernames use 3–64 characters: a–z, 0–9, ".", "_" or "-".',
  weak_password: 'Use at least 10 characters for your password.',
  username_taken: 'That username is taken on this server.',
  registration_closed: 'This server does not accept new accounts.',
  insecure_url: 'The server address must start with https:// (http:// only for localhost).',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  network: 'Could not reach the server. Check the address and your connection.',
  weak_kdf: 'The server offered unsafe key settings. Refusing to continue.',
  not_signed_in: 'This browser is not signed in.',
  sync_required: 'BookSync needs one successful sync first. Try again in a moment.',
  unauthorized: 'This browser was signed out by the server. Sign in again.',
  version_conflict: 'Another browser just changed your bookmarks. Try again.',
  too_large: 'Your bookmarks exceed this account’s size limit on the server.',
};

export function errorText(e: unknown): string {
  if (e instanceof RpcError) return MESSAGES[e.code] ?? e.message;
  return e instanceof Error ? e.message : String(e);
}
