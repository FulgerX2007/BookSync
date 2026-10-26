import { describe, expect, it } from 'vitest';
import { badgeFor } from './badge';
import type { StatusView } from './messages';

const base: StatusView = {
  signedIn: true,
  needsReLogin: false,
  username: 'alice',
  serverUrl: 'https://s',
  status: 'ok',
  paused: false,
  lastSyncAt: 1,
  lastError: null,
  version: 1,
  nextAttemptAt: 0,
  pendingConfirmation: null,
  nativeSyncAck: false,
  builtinSyncOff: false,
};

describe('badgeFor', () => {
  it('is empty while all is well or merely signed out', () => {
    expect(badgeFor(base).text).toBe('');
    expect(badgeFor({ ...base, status: 'syncing' }).text).toBe('');
    expect(badgeFor({ ...base, signedIn: false }).text).toBe('');
  });

  it.each(['error', 'needs_confirmation', 'rollback_detected', 'roots_changed', 'native_sync_detected'] as const)('flags %s', (status) => {
    expect(badgeFor({ ...base, status }).text).toBe('!');
  });

  it('flags a device the server signed out, and shows pause', () => {
    expect(badgeFor({ ...base, signedIn: false, needsReLogin: true }).text).toBe('!');
    expect(badgeFor({ ...base, paused: true, status: 'paused' }).text).toBe('‖');
  });
});
