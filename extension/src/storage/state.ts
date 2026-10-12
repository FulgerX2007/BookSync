// Typed local state of the extension. See "Local extension state" in the plan.
import type { Guid, VaultDoc } from '../model/vault';
import { Db, INDEX_GUID, STORE_IDMAP, STORE_KV, idbRequest, openDb } from './db';

export interface Session {
  serverUrl: string;
  username: string;
  userId: string;
  deviceId: string;
  /** null after the server revoked the device (401); everything else is kept. */
  deviceToken: string | null;
  syncId: Uint8Array;
  iterations: number;
  /** The vault key wrapped under kek, needed to re-wrap on password change. */
  wrappedVaultKey: Uint8Array;
}

export type SyncStatus =
  | 'never'
  | 'syncing'
  | 'ok'
  | 'paused'
  | 'signed_out'
  | 'error'
  | 'needs_confirmation'
  | 'conflict_exhausted'
  | 'rollback_detected'
  | 'roots_changed'
  | 'native_sync_detected';

export interface PendingConfirmation {
  /** The server version the user is asked about; a confirmation is only valid for it. */
  remoteVersion: number | null;
  deletionsToLocal: number;
  deletionsToRemote: number;
}

/** Native ids of the canonical roots (and the Chromium menu folder) chosen on first sync. */
export type RootPins = Record<string, string>;

export interface SyncState {
  base: VaultDoc | null;
  /** Server version (ETag) that base corresponds to. */
  version: number | null;
  lastSeq: number;
  skipped: Guid[];
  pendingApply: VaultDoc | null;
  pendingConfirmation: PendingConfirmation | null;
  status: SyncStatus;
  lastError: string | null;
  lastSyncAt: number | null;
  paused: boolean;
  /** Backoff: no automatic sync before this time (ms epoch). */
  nextAttemptAt: number;
  rootPins: RootPins | null;
  nativeSyncAck: boolean;
}

export function defaultSyncState(): SyncState {
  return {
    base: null,
    version: null,
    lastSeq: 0,
    skipped: [],
    pendingApply: null,
    pendingConfirmation: null,
    status: 'never',
    lastError: null,
    lastSyncAt: null,
    paused: false,
    nextAttemptAt: 0,
    rootPins: null,
    nativeSyncAck: false,
  };
}

export interface IdMapEntry {
  /** The browser's bookmark id. */
  localId: string;
  guid: Guid;
  /** The URL as the browser stored it after our last write (see URL canonicalization). */
  nativeUrl?: string;
}

const KEY_SESSION = 'session';
const KEY_VAULT_KEY = 'vaultKey';
const KEY_SYNC = 'sync';

export class StateStore {
  private constructor(private readonly db: Db) {}

  static async open(name?: string): Promise<StateStore> {
    return new StateStore(new Db(await openDb(name)));
  }

  close(): void {
    this.db.close();
  }

  async getSession(): Promise<Session | null> {
    return (await this.db.get<Session>(STORE_KV, KEY_SESSION)) ?? null;
  }

  async setSession(session: Session): Promise<void> {
    await this.db.write(STORE_KV, (tx) => void tx.objectStore(STORE_KV).put(session, KEY_SESSION));
  }

  async getVaultKey(): Promise<CryptoKey | null> {
    return (await this.db.get<CryptoKey>(STORE_KV, KEY_VAULT_KEY)) ?? null;
  }

  async setVaultKey(key: CryptoKey): Promise<void> {
    await this.db.write(STORE_KV, (tx) => void tx.objectStore(STORE_KV).put(key, KEY_VAULT_KEY));
  }

  async getSync(): Promise<SyncState> {
    return { ...defaultSyncState(), ...(await this.db.get<Partial<SyncState>>(STORE_KV, KEY_SYNC)) };
  }

  /** Atomically merges patch into the sync state and returns the result. */
  async updateSync(patch: Partial<SyncState>): Promise<SyncState> {
    let next = defaultSyncState();
    await this.db.write(STORE_KV, async (tx) => {
      const store = tx.objectStore(STORE_KV);
      const cur = (await idbRequest(store.get(KEY_SYNC))) as Partial<SyncState> | undefined;
      next = { ...defaultSyncState(), ...cur, ...patch };
      store.put(next, KEY_SYNC);
    });
    return next;
  }

  async loadIdMap(): Promise<IdMap> {
    return new IdMap(await this.db.getAll<IdMapEntry>(STORE_IDMAP), this);
  }

  /** Binds localId ↔ guid, dropping any previous binding of either side. */
  async putIdMapEntry(entry: IdMapEntry): Promise<void> {
    await this.db.write(STORE_IDMAP, async (tx) => {
      const store = tx.objectStore(STORE_IDMAP);
      const clash = (await idbRequest(store.index(INDEX_GUID).getKey(entry.guid))) as string | undefined;
      if (clash !== undefined && clash !== entry.localId) store.delete(clash);
      store.put(entry);
    });
  }

  async deleteIdMapEntry(localId: string): Promise<void> {
    await this.db.write(STORE_IDMAP, (tx) => void tx.objectStore(STORE_IDMAP).delete(localId));
  }

  /** Logout: forget everything. Browser bookmarks are never touched. */
  async clearAccount(): Promise<void> {
    await this.db.write([STORE_KV, STORE_IDMAP], (tx) => {
      tx.objectStore(STORE_KV).clear();
      tx.objectStore(STORE_IDMAP).clear();
    });
  }

  /**
   * The server revoked this device (401): drop the token and the vault key
   * only. Base, id map, SyncID and lastSeq stay, so signing in again resumes
   * a guarded merge instead of a fresh join.
   */
  async clearCredentials(): Promise<void> {
    await this.db.write(STORE_KV, async (tx) => {
      const store = tx.objectStore(STORE_KV);
      const session = (await idbRequest(store.get(KEY_SESSION))) as Session | undefined;
      if (session) store.put({ ...session, deviceToken: null }, KEY_SESSION);
      store.delete(KEY_VAULT_KEY);
    });
  }
}

export interface IdMapPersistence {
  putIdMapEntry(entry: IdMapEntry): Promise<void>;
  deleteIdMapEntry(localId: string): Promise<void>;
}

/**
 * In-memory bidirectional browser-id ↔ guid map, persisted entry by entry so
 * an interrupted apply never loses a binding it already made.
 */
export class IdMap {
  private readonly byLocal = new Map<string, IdMapEntry>();
  private readonly byGuid = new Map<Guid, IdMapEntry>();

  constructor(
    entries: readonly IdMapEntry[] = [],
    private readonly persistence?: IdMapPersistence,
  ) {
    for (const e of entries) this.bind(e);
  }

  guidOf(localId: string): Guid | undefined {
    return this.byLocal.get(localId)?.guid;
  }

  localIdOf(guid: Guid): string | undefined {
    return this.byGuid.get(guid)?.localId;
  }

  entryOf(localId: string): IdMapEntry | undefined {
    return this.byLocal.get(localId);
  }

  entries(): IdMapEntry[] {
    return [...this.byLocal.values()];
  }

  get size(): number {
    return this.byLocal.size;
  }

  async set(entry: IdMapEntry): Promise<void> {
    this.bind({ ...entry });
    await this.persistence?.putIdMapEntry({ ...entry });
  }

  async remove(localId: string): Promise<void> {
    const e = this.byLocal.get(localId);
    if (!e) return;
    this.byLocal.delete(localId);
    if (this.byGuid.get(e.guid) === e) this.byGuid.delete(e.guid);
    await this.persistence?.deleteIdMapEntry(localId);
  }

  private bind(e: IdMapEntry): void {
    const oldForLocal = this.byLocal.get(e.localId);
    if (oldForLocal && this.byGuid.get(oldForLocal.guid) === oldForLocal) this.byGuid.delete(oldForLocal.guid);
    const oldForGuid = this.byGuid.get(e.guid);
    if (oldForGuid && oldForGuid.localId !== e.localId) this.byLocal.delete(oldForGuid.localId);
    this.byLocal.set(e.localId, e);
    this.byGuid.set(e.guid, e);
  }
}
