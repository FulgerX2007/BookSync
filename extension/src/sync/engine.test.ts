import { describe, expect, it } from 'vitest';
import { Device, World } from '../../test/harness';
import { ROOT_GUIDS, countNodes, isRoot, treesEqual, type VaultDoc } from '../model/vault';

/** Titles in tree order, roots by canonical guid — comparable across browsers. */
function titles(d: VaultDoc): string {
  const out: string[] = [];
  const walk = (g: string, depth: number) => {
    const n = d.nodes[g]!;
    out.push(`${'  '.repeat(depth)}${isRoot(g) ? g : n.title}${n.url ? ` <${n.url}>` : ''}`);
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  for (const r of ROOT_GUIDS) walk(r, 0);
  return out.join('\n');
}

async function expectConverged(...devices: Device[]) {
  const [first, ...rest] = await Promise.all(devices.map((d) => d.projection()));
  for (const p of rest) {
    expect(titles(p)).toBe(titles(first!));
    expect(treesEqual(p, first!)).toBe(true);
  }
}

const count = (d: Device, title: string) => (d.fake.dump().match(new RegExp(`- ${title} <`, 'g')) ?? []).length;

async function twoDevices() {
  const w = await World.create();
  const a = await w.device('A', 'chromium');
  const b = await w.device('B', 'firefox');
  await a.fake.addBookmark(a.roots.toolbar, 'Example', 'https://example.com/');
  const news = await a.fake.addFolder(a.roots.toolbar, 'News');
  await a.fake.addBookmark(news.id, 'Paper', 'https://paper.example/');
  await a.syncOk();
  await b.syncOk();
  return { w, a, b };
}

describe('syncOnce: bootstrap and join', () => {
  it('bootstraps the account from the first device', async () => {
    const w = await World.create();
    const a = await w.device('A', 'chromium');
    await a.fake.addBookmark(a.roots.toolbar, 'Example', 'https://example.com/');
    const r = await a.syncOk();
    expect(r).toMatchObject({ uploaded: true, version: 1 });
    const st = await a.state.getSync();
    expect([st.version, st.lastSeq, st.status, st.pendingApply]).toEqual([1, 1, 'ok', null]);
    expect(countNodes(st.base!)).toBe(1);
  });

  it('joins a second device without duplicates and spreads its extras', async () => {
    const w = await World.create();
    const a = await w.device('A', 'chromium');
    const b = await w.device('B', 'firefox');
    await a.fake.addBookmark(a.roots.toolbar, 'Example', 'https://example.com/');
    const news = await a.fake.addFolder(a.roots.toolbar, 'News');
    await a.fake.addBookmark(news.id, 'Paper', 'https://paper.example/');
    await a.syncOk();

    await b.fake.addBookmark(b.roots.toolbar, 'Example', 'https://EXAMPLE.com');
    await b.fake.addBookmark(b.roots.toolbar, 'Extra', 'https://extra.example/');
    await b.syncOk();
    expect(count(b, 'Example')).toBe(1);
    expect(b.fake.findByTitle('Paper')).toBeDefined();

    await a.syncOk();
    expect(a.fake.findByTitle('Extra')).toBeDefined();
    await expectConverged(a, b);
  });
});

describe('syncOnce: steady state', () => {
  it('uploads local changes and applies remote ones', async () => {
    const { a, b } = await twoDevices();
    await a.fake.update(a.fake.findByTitle('Example')!.id, { title: 'Renamed' });
    expect((await a.syncOk()).uploaded).toBe(true);
    const r = await b.syncOk();
    expect(r.uploaded).toBe(false);
    expect(b.fake.findByTitle('Renamed')).toBeDefined();
    await expectConverged(a, b);
  });

  it('makes no browser writes and no upload when nothing changed', async () => {
    const { w, a } = await twoDevices();
    await a.syncOk();
    const writes = a.fake.writes;
    const puts = w.server.calls.filter((c) => c === 'putVault').length;
    const r = await a.syncOk();
    expect(r).toMatchObject({ uploaded: false, writes: 0 });
    expect(a.fake.writes).toBe(writes);
    expect(w.server.calls.filter((c) => c === 'putVault').length).toBe(puts);
  });

  it('retries after a 412 and merges the concurrent write', async () => {
    const { w, a, b } = await twoDevices();
    await a.fake.addBookmark(a.roots.toolbar, 'From A', 'https://a.example/');
    await b.fake.addBookmark(b.roots.toolbar, 'From B', 'https://b.example/');
    w.server.beforePut = async () => {
      w.server.beforePut = null;
      await b.syncOk(); // B wins the race
    };
    await a.syncOk();
    expect(a.fake.findByTitle('From B')).toBeDefined();
    await b.syncOk();
    expect(b.fake.findByTitle('From A')).toBeDefined();
    await expectConverged(a, b);
  });

  it('gives up after repeated conflicts', async () => {
    const { w, a } = await twoDevices();
    await a.fake.addBookmark(a.roots.toolbar, 'X', 'https://x.example/');
    w.server.beforePut = () => {
      w.server.forcePut(w.userId, w.server.latest(w.userId)!.body);
    };
    expect(await a.sync()).toEqual({ status: 'conflict_exhausted' });
    expect((await a.state.getSync()).status).toBe('conflict_exhausted');
  });
});

describe('syncOnce: rollback', () => {
  async function rolledBack() {
    const { w, a, b } = await twoDevices();
    await a.fake.addBookmark(a.roots.toolbar, 'After backup', 'https://late.example/');
    await a.syncOk();
    await b.syncOk();
    w.server.rollbackTo(w.userId, 1);
    return { w, a, b };
  }

  it('detects a server that went back in time', async () => {
    const { a } = await rolledBack();
    expect(await a.sync()).toMatchObject({ status: 'rollback_detected', remoteSeq: 1, lastSeq: 2 });
    expect((await a.state.getSync()).status).toBe('rollback_detected');
  });

  it('recovers with "use this browser" and other devices accept the result', async () => {
    const { w, a, b } = await rolledBack();
    const r = await a.syncOk({ recovery: 'use_local' });
    expect(r.uploaded).toBe(true);
    expect((await a.state.getSync()).lastSeq).toBe(3);
    await b.syncOk();
    expect(b.fake.findByTitle('After backup')).toBeDefined();
    expect(w.server.latest(w.userId)!.version).toBe(2);
  });

  it('recovers with "accept server version", dropping what the backup lacks', async () => {
    const { a } = await rolledBack();
    await a.syncOk({ recovery: 'accept_remote' });
    expect(a.fake.findByTitle('After backup')).toBeUndefined();
    expect((await a.state.getSync()).lastSeq).toBe(1);
    expect((await a.sync()).status).toBe('ok');
  });

  it('treats an emptied server as a rollback', async () => {
    const { w, a } = await twoDevices();
    w.server.vaults.delete(w.userId);
    expect((await a.sync()).status).toBe('rollback_detected');
  });
});

describe('syncOnce: mass-deletion guard', () => {
  async function forty() {
    const w = await World.create();
    const a = await w.device('A', 'chromium');
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push((await a.fake.addBookmark(a.roots.toolbar, `b${i}`, `https://b${i}.example/`)).id);
    await a.syncOk();
    return { w, a, ids };
  }

  it('asks before deleting many bookmarks on the server, then proceeds once confirmed', async () => {
    const { w, a, ids } = await forty();
    for (const id of ids.slice(0, 30)) await a.fake.remove(id);
    const r = await a.sync();
    expect(r).toEqual({ status: 'needs_confirmation', pending: { remoteVersion: 1, deletionsToLocal: 0, deletionsToRemote: 30 } });
    expect(w.server.latest(w.userId)!.version).toBe(1);
    if (r.status !== 'needs_confirmation') throw new Error();
    await a.syncOk({ confirmation: r.pending });
    expect(w.server.latest(w.userId)!.version).toBe(2);
  });

  it('asks again when the server changed after the user saw the summary', async () => {
    const { w, a, ids } = await forty();
    const b = await w.device('B', 'firefox');
    await b.syncOk();
    for (const id of ids.slice(0, 30)) await a.fake.remove(id);
    const first = await a.sync();
    if (first.status !== 'needs_confirmation') throw new Error('expected confirmation');
    await b.fake.addBookmark(b.roots.toolbar, 'new on B', 'https://newb.example/');
    await b.syncOk();
    const second = await a.sync({ confirmation: first.pending });
    expect(second).toMatchObject({ status: 'needs_confirmation', pending: { remoteVersion: 2 } });
    expect(w.server.latest(w.userId)!.version).toBe(2); // nothing was uploaded on the stale confirmation
  });

  it('asks before applying many remote deletions to this browser', async () => {
    const { w, a, ids } = await forty();
    const b = await w.device('B', 'firefox');
    await b.syncOk();
    for (const id of ids.slice(0, 30)) await a.fake.remove(id);
    const r = await a.sync();
    if (r.status !== 'needs_confirmation') throw new Error();
    await a.syncOk({ confirmation: r.pending });
    expect(await b.sync()).toMatchObject({ status: 'needs_confirmation', pending: { deletionsToLocal: 30, deletionsToRemote: 0 } });
    expect(b.fake.findByTitle('b0')).toBeDefined();
  });
});

describe('syncOnce: concurrency and crashes', () => {
  it('restarts when the user edits mid-run, losing nothing', async () => {
    const { a, b } = await twoDevices();
    await b.fake.update(b.fake.findByTitle('Example')!.id, { title: 'Changed on B' });
    await b.syncOk();
    const real = a.api.getVault.bind(a.api);
    let edited = false;
    a.api.getVault = async (v) => {
      if (!edited) {
        edited = true;
        await a.fake.addBookmark(a.roots.toolbar, 'During sync', 'https://during.example/');
      }
      return real(v);
    };
    await a.syncOk();
    expect(a.fake.findByTitle('Changed on B')).toBeDefined();
    await b.syncOk();
    expect(b.fake.findByTitle('During sync')).toBeDefined();
  });

  it('recovers from an apply interrupted mid-way without duplicating bookmarks', async () => {
    const { a, b } = await twoDevices();
    for (let i = 0; i < 5; i++) await b.fake.addBookmark(b.roots.toolbar, `new${i}`, `https://new${i}.example/`);
    await b.syncOk();

    const realCreate = a.adapter.create.bind(a.adapter);
    let creates = 0;
    a.adapter.create = async (...args) => {
      const r = await realCreate(...args);
      if (++creates === 3) throw new Error('worker killed');
      return r;
    };
    expect(await a.sync()).toMatchObject({ status: 'error' });
    a.adapter.create = realCreate;
    expect((await a.state.getSync()).pendingApply).not.toBeNull();

    await a.syncOk();
    for (let i = 0; i < 5; i++) expect(count(a, `new${i}`)).toBe(1);
    await expectConverged(a, b);
  });
});

describe('syncOnce: sign-out, roots and gates', () => {
  it('resumes with a guarded merge after re-login, not re-adding what others deleted', async () => {
    const { w, a, b } = await twoDevices();
    const bSession = (await b.state.getSession())!;
    await a.api.revokeDevice(bSession.deviceId);
    expect(await b.sync()).toEqual({ status: 'signed_out' });
    expect((await b.state.getSession())!.deviceToken).toBeNull();
    expect((await b.state.getSync()).base).not.toBeNull();

    await a.fake.remove(a.fake.findByTitle('Example')!.id);
    await a.syncOk();

    const relogin = await w.server.clientFor(() => null).login({ username: w.username, authKey: new Uint8Array(32).fill(7), deviceName: 'B' });
    await b.state.setSession({ ...bSession, deviceToken: relogin.deviceToken, deviceId: relogin.deviceId });
    await b.state.setVaultKey(w.vaultKey);
    await b.syncOk();
    expect(b.fake.findByTitle('Example')).toBeUndefined();
  });

  it('stops on vanished roots and rejoins without deleting anything', async () => {
    const w = await World.create();
    const a = await w.device('A', 'chromium', { accountStorage: true });
    await a.fake.addBookmark(a.roots.toolbar, 'Keep me', 'https://keep.example/');
    await a.syncOk();
    a.fake.dropRoot('1'); // the local Bookmarks bar is gone
    expect(await a.sync()).toEqual({ status: 'roots_changed' });
    await a.state.updateSync({ nativeSyncAck: true });
    await a.syncOk({ rejoin: true });
    expect(a.fake.findByTitle('Keep me')).toMatchObject({ parentId: '4' });
    const b = await w.device('B', 'firefox');
    await b.syncOk();
    expect(b.fake.findByTitle('Keep me')).toBeDefined();
  });

  it('waits for acknowledgment when the browser syncs bookmarks itself', async () => {
    const w = await World.create();
    const a = await w.device('A', 'chromium', { nativeSync: true });
    expect(await a.sync()).toEqual({ status: 'native_sync_detected' });
    await a.state.updateSync({ nativeSyncAck: true });
    await a.syncOk();
  });

  it('honors pause and backoff unless forced', async () => {
    const { w, a } = await twoDevices();
    await a.state.updateSync({ paused: true });
    expect(await a.sync()).toEqual({ status: 'paused' });
    await a.syncOk({ force: true });
    await a.state.updateSync({ paused: false, nextAttemptAt: w.now() + 60_000 });
    expect((await a.sync()).status).toBe('backoff');
    await a.syncOk({ force: true });
  });

  it('reports network failures as errors', async () => {
    const { w, a } = await twoDevices();
    w.server.offline = true;
    expect(await a.sync()).toMatchObject({ status: 'error', code: 'network' });
    expect((await a.state.getSync()).status).toBe('error');
  });
});
