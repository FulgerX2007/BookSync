// Multi-device test world: one fake server, several simulated browsers, each
// with its own fake bookmarks, IndexedDB state and device token.
import 'fake-indexeddb/auto';
import type { ApiClient } from '../src/api/client';
import type { BookmarksAdapter } from '../src/browser/adapter';
import { ChromiumAdapter } from '../src/browser/chromium';
import { FirefoxAdapter } from '../src/browser/firefox';
import { project } from '../src/browser/projection';
import { encryptVault } from '../src/crypto/vault-cipher';
import type { VaultDoc } from '../src/model/vault';
import { StateStore } from '../src/storage/state';
import { syncOnce, type SyncDeps, type SyncOptions, type SyncResult } from '../src/sync/engine';
import { FakeBookmarks, type FakeOptions } from './fakes/bookmarks';
import { FakeServer } from './fakes/server';

let dbCounter = 0;

export class Device {
  events = 0;
  api: ApiClient;
  readonly adapter: BookmarksAdapter;

  constructor(
    readonly world: World,
    readonly name: string,
    readonly fake: FakeBookmarks,
    readonly state: StateStore,
  ) {
    this.adapter = fake.flavor === 'chromium' ? new ChromiumAdapter(fake) : new FirefoxAdapter(fake);
    this.api = world.server.clientFor(async () => (await state.getSession())?.deviceToken ?? null);
    for (const ev of this.adapter.changeEvents()) ev.addListener(() => this.events++);
  }

  deps(): SyncDeps {
    return { api: this.api, adapter: this.adapter, state: this.state, now: () => this.world.now(), eventCount: () => this.events };
  }

  sync(opts: SyncOptions = {}): Promise<SyncResult> {
    return syncOnce(this.deps(), opts);
  }

  /** Syncs and fails the test unless the run succeeded. */
  async syncOk(opts: SyncOptions = {}): Promise<Extract<SyncResult, { status: 'ok' }>> {
    const r = await this.sync(opts);
    if (r.status !== 'ok') throw new Error(`${this.name}: sync returned ${JSON.stringify(r)}`);
    return r;
  }

  /** The browser's current tree as a VaultDoc (what the next sync would see). */
  async projection(): Promise<VaultDoc> {
    const st = await this.state.getSync();
    const resolved = await this.adapter.resolveRoots(st.rootPins);
    const pins = resolved.status === 'ok' ? resolved.pins : (st.rootPins ?? {});
    return project({ tree: await this.adapter.readTree(pins), idMap: await this.state.loadIdMap(), base: st.base, skipped: new Set(st.skipped) });
  }

  /** Native folder ids by role, for seeding bookmarks. */
  get roots() {
    return this.fake.roots();
  }
}

export class World {
  readonly server = new FakeServer();
  readonly username = 'alice';
  userId = '';
  vaultKey!: CryptoKey;
  private clock = 1_700_000_000_000;
  private authKey = new Uint8Array(32).fill(7);

  static async create(): Promise<World> {
    const w = new World();
    w.vaultKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const reg = await w.server.clientFor(() => null).register({
      username: w.username,
      authKey: w.authKey,
      kdf: 'pbkdf2-sha256',
      iterations: 600000,
      wrappedVaultKey: new Uint8Array([1]),
      deviceName: 'setup',
    });
    w.userId = reg.userId;
    return w;
  }

  now(): number {
    return (this.clock += 1000);
  }

  async device(name: string, flavor: 'chromium' | 'firefox', opts: FakeOptions = {}): Promise<Device> {
    const login = await this.server.clientFor(() => null).login({ username: this.username, authKey: this.authKey, deviceName: name });
    const state = await StateStore.open(`harness-${dbCounter++}`);
    await state.setSession({
      serverUrl: 'https://sync.example',
      username: this.username,
      userId: login.userId,
      deviceId: login.deviceId,
      deviceToken: login.deviceToken,
      syncId: new Uint8Array(16),
      iterations: 600000,
      wrappedVaultKey: login.wrappedVaultKey,
    });
    await state.setVaultKey(this.vaultKey);
    return new Device(this, name, new FakeBookmarks(flavor, opts), state);
  }

  /** Uploads a vault directly, as an unseen device would. */
  async forcePut(doc: VaultDoc): Promise<number> {
    return this.server.forcePut(this.userId, await encryptVault(doc, this.vaultKey, this.username));
  }
}
