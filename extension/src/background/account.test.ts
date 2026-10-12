import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { FakeBookmarks } from '../../test/fakes/bookmarks';
import { FakeServer } from '../../test/fakes/server';
import { ChromiumAdapter } from '../browser/chromium';
import { FirefoxAdapter } from '../browser/firefox';
import { formatSyncId, generateSyncId } from '../crypto/syncid';
import { StateStore } from '../storage/state';
import { syncOnce } from '../sync/engine';
import { Account, PRODUCTION_KDF } from './account';
import { Router } from './router';
import { registerAccountHandlers } from './account';

const KDF = { iterations: 1000, allowWeak: true };
const URL = 'https://sync.example';
const PW = 'correct horse battery';
let n = 0;

async function browser(server: FakeServer, flavor: 'chromium' | 'firefox' = 'chromium', kdf = KDF) {
  const fake = new FakeBookmarks(flavor);
  const adapter = flavor === 'chromium' ? new ChromiumAdapter(fake) : new FirefoxAdapter(fake);
  const state = await StateStore.open(`account-${n++}`);
  let events = 0;
  for (const e of adapter.changeEvents()) e.addListener(() => events++);
  const api = server.clientFor(async () => (await state.getSession())?.deviceToken ?? null);
  const sync = (opts = {}) => syncOnce({ api, adapter, state, now: () => Date.now(), eventCount: () => events }, opts);
  const account = new Account({ state, clientFor: (_url, token) => server.clientFor(token), sync, now: () => Date.UTC(2026, 9, 12), kdf });
  return { fake, adapter, state, account, sync };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return (e as { code?: string }).code ?? 'other';
  }
}

async function registered() {
  const server = new FakeServer();
  const a = await browser(server);
  await a.fake.addBookmark('1', 'From A', 'https://a.example/');
  const kit = await a.account.register({ serverUrl: URL, username: 'Alice', password: PW, deviceName: 'Chrome' });
  return { server, a, kit };
}

describe('register and login', () => {
  it('registers, uploads, and lets a second browser decrypt with the same vault key', async () => {
    const { server, a, kit } = await registered();
    expect(kit.syncId).toMatch(/^BS1-/);
    expect((await a.state.getSession())!.username).toBe('alice');
    expect(server.latest(server.userByName('alice')!.userId)?.version).toBe(1);

    const b = await browser(server, 'firefox');
    const view = await b.account.login({ serverUrl: URL, username: 'alice', password: PW, syncId: kit.syncId.toLowerCase(), deviceName: 'Firefox' });
    expect(view).toMatchObject({ signedIn: true, status: 'ok', username: 'alice' });
    expect(b.fake.findByTitle('From A')).toBeDefined();
  });

  it('rejects a wrong password, a wrong SyncID and a mistyped SyncID', async () => {
    const { server, kit } = await registered();
    const b = await browser(server);
    const login = (password: string, syncId: string) => b.account.login({ serverUrl: URL, username: 'alice', password, syncId, deviceName: 'x' });
    expect(await codeOf(login('wrong password!', kit.syncId))).toBe('invalid_credentials');
    expect(await codeOf(login(PW, formatSyncId(generateSyncId())))).toBe('invalid_credentials');
    const typo = kit.syncId.slice(0, -1) + (kit.syncId.endsWith('0') ? '1' : '0');
    expect(await codeOf(login(PW, typo))).toBe('invalid_checksum');
    expect(await b.state.getSession()).toBeNull();
  });

  it('validates username, password and server URL on registration', async () => {
    const b = await browser(new FakeServer());
    expect(await codeOf(b.account.register({ serverUrl: URL, username: 'x', password: PW, deviceName: 'd' }))).toBe('invalid_username');
    expect(await codeOf(b.account.register({ serverUrl: URL, username: 'alice', password: 'short', deviceName: 'd' }))).toBe('weak_password');
    expect(await codeOf(b.account.register({ serverUrl: 'http://sync.example', username: 'alice', password: PW, deviceName: 'd' }))).toBe('insecure_url');
  });

  it('refuses weak KDF parameters offered by the server', async () => {
    const { server, kit } = await registered(); // account uses 1000 iterations
    const strict = await browser(server, 'chromium', PRODUCTION_KDF);
    expect(await codeOf(strict.account.login({ serverUrl: URL, username: 'alice', password: PW, syncId: kit.syncId, deviceName: 'x' }))).toBe('weak_kdf');
  });

  it('resumes the same account after revocation but starts fresh for another account', async () => {
    const { server, a, kit } = await registered();
    const before = await a.state.getSync();
    server.revokeAll(server.userByName('alice')!.userId);
    expect((await a.sync()).status).toBe('signed_out');
    await a.account.login({ serverUrl: URL, username: 'alice', password: PW, syncId: kit.syncId, deviceName: 'Chrome' });
    expect((await a.state.getSync()).lastSeq).toBeGreaterThanOrEqual(before.lastSeq);
    expect((await a.state.loadIdMap()).size).toBeGreaterThan(0);

    const kitBob = await (await browser(server)).account.register({ serverUrl: URL, username: 'bob', password: PW, deviceName: 'x' });
    await a.account.login({ serverUrl: URL, username: 'bob', password: PW, syncId: kitBob.syncId, deviceName: 'Chrome' });
    expect((await a.state.getSession())!.username).toBe('bob');
    expect(server.userByName('bob')).toBeDefined();
  });
});

describe('password change', () => {
  it('re-wraps the key: old password stops working, others are signed out, history kept', async () => {
    const { server, a, kit } = await registered();
    const b = await browser(server);
    await b.account.login({ serverUrl: URL, username: 'alice', password: PW, syncId: kit.syncId, deviceName: 'B' });

    expect(await a.account.changePassword({ currentPassword: PW, newPassword: 'a brand new password', rotateKeys: false })).toEqual({ kit: null });
    expect((await b.sync()).status).toBe('signed_out');
    const c = await browser(server);
    expect(await codeOf(c.account.login({ serverUrl: URL, username: 'alice', password: PW, syncId: kit.syncId, deviceName: 'C' }))).toBe('invalid_credentials');
    await c.account.login({ serverUrl: URL, username: 'alice', password: 'a brand new password', syncId: kit.syncId, deviceName: 'C' });
    expect(c.fake.findByTitle('From A')).toBeDefined();
    expect((await a.sync()).status).toBe('ok');
  });

  it('rejects a wrong current password locally', async () => {
    const { a, server } = await registered();
    const before = server.calls.length;
    expect(await codeOf(a.account.changePassword({ currentPassword: 'not my password', newPassword: 'whatever new pw', rotateKeys: false }))).toBe('invalid_credentials');
    expect(server.calls.length).toBe(before);
  });

  it('rotates keys: new SyncID and vault key, history replaced, others must use the new kit', async () => {
    const { server, a, kit } = await registered();
    const b = await browser(server, 'firefox');
    await b.account.login({ serverUrl: URL, username: 'alice', password: PW, syncId: kit.syncId, deviceName: 'B' });
    await a.fake.addBookmark('1', 'Second', 'https://second.example/');
    await a.sync();

    const { kit: newKit } = await a.account.changePassword({ currentPassword: PW, newPassword: 'rotated password!', rotateKeys: true });
    expect(newKit).not.toBeNull();
    expect(newKit!.syncId).not.toBe(kit.syncId);
    const userId = server.userByName('alice')!.userId;
    expect(server.vaults.get(userId)).toHaveLength(1);
    expect((await a.sync()).status).toBe('ok');

    expect((await b.sync()).status).toBe('signed_out');
    expect(await codeOf(b.account.login({ serverUrl: URL, username: 'alice', password: 'rotated password!', syncId: kit.syncId, deviceName: 'B' }))).toBe('invalid_credentials');
    await b.account.login({ serverUrl: URL, username: 'alice', password: 'rotated password!', syncId: newKit!.syncId, deviceName: 'B' });
    expect((await b.state.getSync()).status).toBe('ok');
    expect(b.fake.findByTitle('Second')).toBeDefined();
  });
});

describe('logout, delete and kit', () => {
  it('logs out: revokes server-side and clears local state, keeping bookmarks', async () => {
    const { server, a } = await registered();
    const view = await a.account.logout();
    expect(view).toMatchObject({ signedIn: false, needsReLogin: false });
    expect(await a.state.getSession()).toBeNull();
    expect(server.devices.size).toBe(0);
    expect(a.fake.findByTitle('From A')).toBeDefined();
  });

  it('deletes the account with the password', async () => {
    const { server, a } = await registered();
    expect(await codeOf(a.account.deleteAccount({ password: 'wrong password!' }))).toBe('invalid_credentials');
    await a.account.deleteAccount({ password: PW });
    expect(server.userByName('alice')).toBeUndefined();
    expect(await a.state.getSession()).toBeNull();
  });

  it('produces a kit with the SyncID and never the password', async () => {
    const { a, kit } = await registered();
    expect(kit.text).toContain(kit.syncId);
    expect(kit.text).toContain('alice');
    expect(kit.text).toContain(URL);
    expect(kit.text).not.toContain(PW);
    expect(kit.fileName).toBe('booksync-emergency-kit-alice.txt');
    expect((await a.account.getEmergencyKit()).syncId).toBe(kit.syncId);
  });

  it('lists and revokes devices', async () => {
    const { server, a, kit } = await registered();
    const b = await browser(server);
    await b.account.login({ serverUrl: URL, username: 'alice', password: PW, syncId: kit.syncId, deviceName: 'B' });
    const list = await a.account.listDevices();
    expect(list.map((d) => d.name).sort()).toEqual(['B', 'Chrome']);
    const after = await a.account.revokeDevice(list.find((d) => d.name === 'B')!.id);
    expect(after.map((d) => d.name)).toEqual(['Chrome']);
  });
});

describe('account message handlers', () => {
  it('validates required fields', async () => {
    const { a } = await registered();
    const router = new Router();
    registerAccountHandlers(router, a.account);
    expect(await router.dispatch({ type: 'login', username: 'alice' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await router.dispatch({ type: 'getEmergencyKit' })).toMatchObject({ ok: true });
  });
});
