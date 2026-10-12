// Minimal promise wrapper over IndexedDB. Extension pages and the background
// share one origin, so they share this database.

export const DB_NAME = 'booksync';
const DB_VERSION = 1;

export const STORE_KV = 'kv';
export const STORE_IDMAP = 'idmap';
export const INDEX_GUID = 'guid';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // The failing request carries the error; tx.error may still be null here.
    tx.onerror = (ev) => reject((ev.target as IDBRequest | null)?.error ?? tx.error ?? new Error('transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export function openDb(name = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
      if (!db.objectStoreNames.contains(STORE_IDMAP)) {
        const s = db.createObjectStore(STORE_IDMAP, { keyPath: 'localId' });
        s.createIndex(INDEX_GUID, 'guid', { unique: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class Db {
  constructor(readonly idb: IDBDatabase) {}

  async get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    return (await request(this.idb.transaction(store).objectStore(store).get(key))) as T | undefined;
  }

  async getAll<T>(store: string): Promise<T[]> {
    return (await request(this.idb.transaction(store).objectStore(store).getAll())) as T[];
  }

  async getByIndex<T>(store: string, index: string, key: IDBValidKey): Promise<T | undefined> {
    return (await request(this.idb.transaction(store).objectStore(store).index(index).get(key))) as T | undefined;
  }

  /** Runs fn inside one readwrite transaction over stores and waits for it to commit. */
  async write(stores: string | string[], fn: (tx: IDBTransaction) => void | Promise<void>): Promise<void> {
    const tx = this.idb.transaction(stores, 'readwrite');
    const committed = done(tx);
    try {
      await fn(tx);
    } catch (e) {
      tx.abort();
      await committed.catch(() => undefined);
      throw e;
    }
    await committed;
  }

  close(): void {
    this.idb.close();
  }
}

export { request as idbRequest };
