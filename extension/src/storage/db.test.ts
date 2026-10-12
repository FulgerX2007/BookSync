import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Db, STORE_IDMAP, STORE_KV, openDb } from './db';

let n = 0;
const fresh = async () => new Db(await openDb(`db-test-${n++}`));

describe('Db', () => {
  it('creates the stores on first open', async () => {
    const db = await fresh();
    expect([...db.idb.objectStoreNames].sort()).toEqual([STORE_IDMAP, STORE_KV]);
  });

  it('reopens an existing database without losing data', async () => {
    const name = `db-test-${n++}`;
    const a = new Db(await openDb(name));
    await a.write(STORE_KV, (tx) => void tx.objectStore(STORE_KV).put('v', 'k'));
    a.close();
    const b = new Db(await openDb(name));
    expect(await b.get(STORE_KV, 'k')).toBe('v');
  });

  it('reads, writes and indexes', async () => {
    const db = await fresh();
    await db.write(STORE_IDMAP, (tx) => {
      tx.objectStore(STORE_IDMAP).put({ localId: '1', guid: 'g1' });
      tx.objectStore(STORE_IDMAP).put({ localId: '2', guid: 'g2' });
    });
    expect(await db.getAll(STORE_IDMAP)).toHaveLength(2);
    expect(await db.getByIndex(STORE_IDMAP, 'guid', 'g2')).toEqual({ localId: '2', guid: 'g2' });
    expect(await db.get(STORE_IDMAP, 'missing')).toBeUndefined();
  });

  it('rolls back a transaction whose callback throws', async () => {
    const db = await fresh();
    await expect(
      db.write(STORE_KV, (tx) => {
        tx.objectStore(STORE_KV).put('v', 'k');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.get(STORE_KV, 'k')).toBeUndefined();
  });

  it('rejects a write that violates the unique guid index', async () => {
    const db = await fresh();
    await db.write(STORE_IDMAP, (tx) => void tx.objectStore(STORE_IDMAP).put({ localId: '1', guid: 'g' }));
    await expect(db.write(STORE_IDMAP, (tx) => void tx.objectStore(STORE_IDMAP).put({ localId: '2', guid: 'g' }))).rejects.toBeTruthy();
  });
});
