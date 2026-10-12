import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { World, type Device } from '../../test/harness';
import type { LocalNode } from '../browser/adapter';
import { treesEqual, validateTree } from '../model/vault';
import type { SyncOptions } from './engine';

type Edit = { op: 'add' | 'addFolder' | 'rename' | 'reurl' | 'move' | 'delete'; a: number; b: number; c: number };
type Action = { device: number } & ({ kind: 'sync' } | { kind: 'edit'; edit: Edit });

const arbEdit: fc.Arbitrary<Edit> = fc.record({
  op: fc.constantFrom('add', 'add', 'add', 'add', 'addFolder', 'addFolder', 'rename', 'reurl', 'move', 'move', 'delete'),
  a: fc.nat(1000),
  b: fc.nat(1000),
  c: fc.nat(1000),
});
const arbAction: fc.Arbitrary<Action> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ device: fc.nat(2), kind: fc.constant('edit' as const), edit: arbEdit }) },
  { weight: 1, arbitrary: fc.record({ device: fc.nat(2), kind: fc.constant('sync' as const) }) },
);

// Some URLs end in an empty fragment, which the Firefox fake drops on save.
const url = (n: number) => `https://u${n % 5}.example/${n % 3 === 0 ? '#' : ''}`;

/** Applies a user edit through the browser API, like a person would. */
async function userEdit(d: Device, e: Edit): Promise<void> {
  const st = await d.state.getSync();
  const roots = await d.adapter.resolveRoots(st.rootPins);
  if (roots.status !== 'ok') return;
  const tree = await d.adapter.readTree(roots.pins);
  const all = [...tree.nodes.values()];
  const folders = all.filter((n) => n.kind === 'folder');
  const items = all.filter((n) => n.parentId !== '');
  const isInside = (n: LocalNode, ancestor: string): boolean => {
    for (let p: LocalNode | undefined = n; p; p = tree.nodes.get(p.parentId)) if (p.id === ancestor) return true;
    return false;
  };
  switch (e.op) {
    case 'add':
    case 'addFolder': {
      const parent = folders[e.a % folders.length]!;
      const index = e.c % ((parent.children?.length ?? 0) + 1);
      if (e.op === 'add') await d.fake.addBookmark(parent.id, `t${e.b % 6}`, url(e.c), index);
      else await d.fake.addFolder(parent.id, `t${e.b % 6}`, index);
      return;
    }
    case 'rename':
    case 'reurl':
    case 'move':
    case 'delete': {
      if (items.length === 0) return;
      const n = items[e.a % items.length]!;
      if (e.op === 'rename') await d.fake.update(n.id, { title: `t${e.b % 6}` });
      else if (e.op === 'reurl') {
        if (n.kind === 'bookmark') await d.fake.update(n.id, { url: url(e.b) });
      } else if (e.op === 'move') {
        const targets = folders.filter((f) => !isInside(f, n.id));
        const target = targets[e.b % targets.length]!;
        await d.fake.move(n.id, { parentId: target.id, index: e.c % ((target.children?.length ?? 0) + 1) });
      } else {
        const removeTree = async (id: string) => {
          for (const c of tree.nodes.get(id)?.children ?? []) await removeTree(c);
          await d.fake.remove(id);
        };
        await removeTree(n.id);
      }
    }
  }
}

/** Syncs, confirming a mass deletion if the guard asks, and requires success. */
async function syncConfirming(d: Device): Promise<void> {
  let opts: SyncOptions = {};
  for (let i = 0; i < 3; i++) {
    const r = await d.sync(opts);
    if (r.status === 'ok') return;
    if (r.status !== 'needs_confirmation') throw new Error(`${d.name}: ${JSON.stringify(r)}`);
    opts = { confirmation: r.pending };
  }
  throw new Error(`${d.name}: guard did not settle`);
}

describe('multi-device convergence', () => {
  it('converges to one valid tree and then settles', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 3 }), fc.array(arbAction, { maxLength: 60, size: 'medium' }), async (n, actions) => {
        const w = await World.create();
        const devices: Device[] = [];
        for (let i = 0; i < n; i++) devices.push(await w.device(`D${i}`, i % 2 === 0 ? 'chromium' : 'firefox'));

        for (const act of actions) {
          const d = devices[act.device % n]!;
          if (act.kind === 'sync') await syncConfirming(d);
          else await userEdit(d, act.edit);
        }

        // Two full rounds spread everything everywhere.
        for (let round = 0; round < 2; round++) for (const d of devices) await syncConfirming(d);

        const projections = await Promise.all(devices.map((d) => d.projection()));
        for (const p of projections) {
          expect(validateTree(p)).toEqual([]);
          expect(treesEqual(p, projections[0]!)).toBe(true);
        }

        // Settled: another round changes nothing anywhere.
        const writes = devices.map((d) => d.fake.writes);
        const puts = w.server.calls.filter((c) => c === 'putVault').length;
        for (const d of devices) {
          const r = await d.sync();
          expect(r).toMatchObject({ status: 'ok', uploaded: false, writes: 0 });
        }
        expect(devices.map((d) => d.fake.writes)).toEqual(writes);
        expect(w.server.calls.filter((c) => c === 'putVault').length).toBe(puts);
      }),
      { numRuns: Number(process.env.FC_RUNS ?? 60) },
    );
  }, 600_000);
});
