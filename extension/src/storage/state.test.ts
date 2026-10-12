import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { doc } from '../../test/builders';
import { ROOT_TOOLBAR } from '../model/vault';
import { IdMap, StateStore, defaultSyncState, type Session } from './state';

let n = 0;
const fresh = () => StateStore.open(`state-test-${n++}`);

const session = (): Session => ({
  serverUrl: 'https://sync.example',
  username: 'alice',
  userId: 'u1',
  deviceId: 'd1',
  deviceToken: 'bst_token',
  syncId: Uint8Array.from({ length: 16 }, (_, i) => i),
  iterations: 600000,
  wrappedVaultKey: new Uint8Array([1, 2, 3]),
});

describe('StateStore', () => {
  it('starts empty with default sync state', async () => {
    const s = await fresh();
    expect(await s.getSession()).toBeNull();
    expect(await s.getVaultKey()).toBeNull();
    expect(await s.getSync()).toEqual(defaultSyncState());
    expect((await s.loadIdMap()).size).toBe(0);
  });

  it('round-trips the session including binary fields', async () => {
    const s = await fresh();
    await s.setSession(session());
    const got = await s.getSession();
    expect(got).toEqual(session());
    expect(got!.syncId).toBeInstanceOf(Uint8Array);
  });

  it('merges sync state patches atomically', async () => {
    const s = await fresh();
    const base = doc({ [ROOT_TOOLBAR]: [{ b: 'a' }] }, 3);
    await s.updateSync({ base, version: 3, lastSeq: 3 });
    const next = await s.updateSync({ status: 'ok', skipped: ['x'] });
    expect(next.base).toEqual(base);
    expect(next.version).toBe(3);
    expect(next.status).toBe('ok');
    expect(await s.getSync()).toEqual(next);
  });

  it('serializes concurrent updates without losing fields', async () => {
    const s = await fresh();
    await Promise.all([s.updateSync({ lastSeq: 5 }), s.updateSync({ status: 'ok' }), s.updateSync({ paused: true })]);
    const st = await s.getSync();
    expect([st.lastSeq, st.status, st.paused]).toEqual([5, 'ok', true]);
  });

  it('persists a non-extractable vault key that stays usable', async () => {
    const s = await fresh();
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await s.setVaultKey(key);
    const back = (await s.getVaultKey())!;
    expect(back.extractable).toBe(false);
    const iv = new Uint8Array(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, back, new Uint8Array([7]));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    expect([...new Uint8Array(pt)]).toEqual([7]);
  });

  it('clearCredentials keeps base, id map, SyncID and lastSeq', async () => {
    const s = await fresh();
    await s.setSession(session());
    await s.setVaultKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']));
    await s.updateSync({ base: doc({}), lastSeq: 9, version: 9 });
    await s.putIdMapEntry({ localId: '1', guid: 'g1' });

    await s.clearCredentials();
    const sess = await s.getSession();
    expect(sess!.deviceToken).toBeNull();
    expect(sess!.syncId).toEqual(session().syncId);
    expect(await s.getVaultKey()).toBeNull();
    const st = await s.getSync();
    expect([st.lastSeq, st.version, st.base !== null]).toEqual([9, 9, true]);
    expect((await s.loadIdMap()).guidOf('1')).toBe('g1');
  });

  it('clearAccount wipes everything', async () => {
    const s = await fresh();
    await s.setSession(session());
    await s.updateSync({ lastSeq: 9 });
    await s.putIdMapEntry({ localId: '1', guid: 'g1' });
    await s.clearAccount();
    expect(await s.getSession()).toBeNull();
    expect(await s.getSync()).toEqual(defaultSyncState());
    expect((await s.loadIdMap()).size).toBe(0);
  });
});

describe('IdMap', () => {
  it('stays bidirectionally consistent across rebinds', async () => {
    const s = await fresh();
    const m = await s.loadIdMap();
    await m.set({ localId: '1', guid: 'a' });
    await m.set({ localId: '2', guid: 'b' });
    // Rebind guid a to another browser node: the old binding must go.
    await m.set({ localId: '3', guid: 'a' });
    expect(m.localIdOf('a')).toBe('3');
    expect(m.guidOf('1')).toBeUndefined();
    // Rebind node 2 to a new guid.
    await m.set({ localId: '2', guid: 'c', nativeUrl: 'https://c/' });
    expect(m.localIdOf('b')).toBeUndefined();
    expect(m.entryOf('2')).toEqual({ localId: '2', guid: 'c', nativeUrl: 'https://c/' });

    const reloaded = await s.loadIdMap();
    expect(reloaded.entries().sort((x, y) => x.localId.localeCompare(y.localId))).toEqual(m.entries().sort((x, y) => x.localId.localeCompare(y.localId)));
  });

  it('removes entries in memory and in storage', async () => {
    const s = await fresh();
    const m = await s.loadIdMap();
    await m.set({ localId: '1', guid: 'a' });
    await m.remove('1');
    await m.remove('missing');
    expect(m.guidOf('1')).toBeUndefined();
    expect(m.localIdOf('a')).toBeUndefined();
    expect((await s.loadIdMap()).size).toBe(0);
  });

  it('binds many entries in one batch, replacing clashing bindings', async () => {
    const s = await fresh();
    const m = await s.loadIdMap();
    await m.set({ localId: 'old', guid: 'g1' });
    await m.setMany([
      { localId: '1', guid: 'g1' },
      { localId: '2', guid: 'g2' },
    ]);
    expect(m.localIdOf('g1')).toBe('1');
    const reloaded = await s.loadIdMap();
    expect(reloaded.size).toBe(2);
    expect(reloaded.guidOf('old')).toBeUndefined();
  });

  it('works without persistence for in-memory use', async () => {
    const m = new IdMap([{ localId: '1', guid: 'a' }]);
    await m.set({ localId: '2', guid: 'b' });
    expect(m.size).toBe(2);
  });
});
