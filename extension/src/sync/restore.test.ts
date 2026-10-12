import { describe, expect, it } from 'vitest';
import { World, type Device } from '../../test/harness';
import { restoreVersion } from './restore';

const restore = (d: Device, version: number) =>
  restoreVersion({ api: d.api, state: d.state, now: () => d.world.now(), sync: (opts) => d.sync(opts) }, version);

async function history() {
  const w = await World.create();
  const a = await w.device('A', 'chromium');
  const b = await w.device('B', 'firefox');
  await a.fake.addBookmark(a.roots.toolbar, 'v1 only', 'https://one.example/');
  await a.syncOk(); // version 1
  await b.syncOk();
  await b.fake.addBookmark(b.roots.toolbar, 'added later', 'https://two.example/');
  await b.syncOk(); // version 2
  await b.fake.addBookmark(b.roots.toolbar, 'added even later', 'https://three.example/');
  await b.syncOk(); // version 3
  return { w, a, b };
}

describe('restoreVersion', () => {
  it('restores old content as a new version that every device accepts', async () => {
    const { w, a, b } = await history();
    expect((await a.state.getSync()).lastSeq).toBe(1); // A is two versions behind

    const r = await restore(a, 1);
    expect(r?.status).toBe('ok');
    const latest = w.server.latest(w.userId)!;
    expect(latest.version).toBe(4);
    expect((await a.state.getSync()).lastSeq).toBe(4);
    expect(a.fake.findByTitle('added later')).toBeUndefined();

    // B synced seq 3 and must take seq 4 as newer, not as a rollback.
    const rb = await b.sync({ confirmation: { remoteVersion: 4, deletionsToLocal: Infinity, deletionsToRemote: Infinity } });
    expect(rb.status).toBe('ok');
    expect(b.fake.findByTitle('added later')).toBeUndefined();
    expect(b.fake.findByTitle('v1 only')).toBeDefined();
  });

  it('retries with a recomputed seq when another device writes during the restore', async () => {
    const { w, a, b } = await history();
    w.server.beforePut = async () => {
      w.server.beforePut = null;
      await b.fake.addBookmark(b.roots.toolbar, 'racing', 'https://race.example/');
      await b.syncOk(); // version 4, seq 4
    };
    expect((await restore(a, 1))?.status).toBe('ok');
    expect(w.server.latest(w.userId)!.version).toBe(5);
    expect((await a.state.getSync()).lastSeq).toBe(5);
  });

  it('fails for an unknown version', async () => {
    const { a } = await history();
    await expect(restore(a, 99)).rejects.toMatchObject({ code: 'not_found' });
  });
});
