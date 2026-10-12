// In-memory BookSync server implementing ApiClient with the real server's
// semantics (304/404/412, history, rotation, revocation), plus hooks for
// tests: inject a concurrent write before a PUT, roll the server back to an
// older version (backup restore), or revoke a device.
import {
  ApiError,
  type ApiClient,
  type ChangePasswordRequest,
  type DeviceInfo,
  type GetVaultResult,
  type KdfParams,
  type LoginSession,
  type PutVaultResult,
  type RegisterRequest,
  type Session,
  type VersionInfo,
} from '../../src/api/client';

interface FUser {
  userId: string;
  username: string;
  authKey: string; // hex
  kdf: string;
  iterations: number;
  wrappedVaultKey: Uint8Array;
}

interface FDevice {
  deviceId: string;
  userId: string;
  name: string;
  createdAt: string;
}

interface FVersion {
  version: number;
  body: Uint8Array;
  deviceName: string;
  createdAt: string;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const copy = (b: Uint8Array) => new Uint8Array(b);

export class FakeServer {
  readonly users = new Map<string, FUser>();
  readonly devices = new Map<string, FDevice>(); // by token
  readonly vaults = new Map<string, FVersion[]>(); // by userId, ascending
  /** Runs before a PUT is applied; use it to simulate a concurrent writer. */
  beforePut: (() => void | Promise<void>) | null = null;
  /** Method names called, in order. */
  readonly calls: string[] = [];
  /** Makes every request fail with a network error while true. */
  offline = false;
  private seq = 0;

  clientFor(getToken: () => string | null | Promise<string | null>): ApiClient {
    return new FakeClient(this, getToken);
  }

  latest(userId: string): FVersion | undefined {
    return this.vaults.get(userId)?.at(-1);
  }

  userByName(username: string): FUser | undefined {
    return this.users.get(username);
  }

  /** Writes a version directly, as another device would (no precondition). */
  forcePut(userId: string, body: Uint8Array, deviceName = 'elsewhere'): number {
    const list = this.vaults.get(userId) ?? [];
    const version = (list.at(-1)?.version ?? 0) + 1;
    list.push({ version, body: copy(body), deviceName, createdAt: new Date(0).toISOString() });
    this.vaults.set(userId, list);
    return version;
  }

  /** Simulates restoring a server backup taken at `version`. */
  rollbackTo(userId: string, version: number): void {
    this.vaults.set(userId, (this.vaults.get(userId) ?? []).filter((v) => v.version <= version));
  }

  revokeAll(userId: string): void {
    for (const [token, d] of this.devices) if (d.userId === userId) this.devices.delete(token);
  }

  /** @internal */
  nextId(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }
}

class FakeClient implements ApiClient {
  constructor(
    private readonly s: FakeServer,
    private readonly getToken: () => string | null | Promise<string | null>,
  ) {}

  private async enter(name: string): Promise<void> {
    this.s.calls.push(name);
    if (this.s.offline) throw new ApiError('network', 'offline');
  }

  private async device(): Promise<[string, FDevice]> {
    const token = await this.getToken();
    if (!token) throw new ApiError('unauthorized', 'this device is signed out');
    const d = this.s.devices.get(token);
    if (!d) throw new ApiError('unauthorized', 'token revoked', 401);
    return [token, d];
  }

  private user(userId: string): FUser {
    for (const u of this.s.users.values()) if (u.userId === userId) return u;
    throw new ApiError('unauthorized', 'user gone', 401);
  }

  private newDevice(userId: string, name: string): Session {
    const token = this.s.nextId('tok_');
    const deviceId = this.s.nextId('dev_');
    this.s.devices.set(token, { deviceId, userId, name, createdAt: new Date(0).toISOString() });
    return { userId, deviceId, deviceToken: token };
  }

  async prelogin(username: string): Promise<KdfParams> {
    await this.enter('prelogin');
    const u = this.s.users.get(username);
    return u ? { kdf: u.kdf, iterations: u.iterations } : { kdf: 'pbkdf2-sha256', iterations: 600000 };
  }

  async register(req: RegisterRequest): Promise<Session> {
    await this.enter('register');
    if (this.s.users.has(req.username)) throw new ApiError('username_taken', 'taken', 409);
    const userId = this.s.nextId('user_');
    this.s.users.set(req.username, {
      userId,
      username: req.username,
      authKey: hex(req.authKey),
      kdf: req.kdf,
      iterations: req.iterations,
      wrappedVaultKey: copy(req.wrappedVaultKey),
    });
    return this.newDevice(userId, req.deviceName);
  }

  async login(req: { username: string; authKey: Uint8Array; deviceName: string }): Promise<LoginSession> {
    await this.enter('login');
    const u = this.s.users.get(req.username);
    if (!u || u.authKey !== hex(req.authKey)) throw new ApiError('invalid_credentials', 'bad credentials', 401);
    return { ...this.newDevice(u.userId, req.deviceName), wrappedVaultKey: copy(u.wrappedVaultKey), kdf: u.kdf, iterations: u.iterations };
  }

  async logout(): Promise<void> {
    await this.enter('logout');
    const [token] = await this.device();
    this.s.devices.delete(token);
  }

  async listDevices(): Promise<DeviceInfo[]> {
    await this.enter('listDevices');
    const [, me] = await this.device();
    return [...this.s.devices.values()]
      .filter((d) => d.userId === me.userId)
      .map((d) => ({ id: d.deviceId, name: d.name, createdAt: d.createdAt, lastSeenAt: d.createdAt, current: d.deviceId === me.deviceId }));
  }

  async revokeDevice(id: string): Promise<void> {
    await this.enter('revokeDevice');
    const [, me] = await this.device();
    for (const [token, d] of this.s.devices) {
      if (d.deviceId === id && d.userId === me.userId) {
        this.s.devices.delete(token);
        return;
      }
    }
    throw new ApiError('not_found', 'device not found', 404);
  }

  async changePassword(req: ChangePasswordRequest): Promise<{ version?: number }> {
    await this.enter('changePassword');
    const [token, me] = await this.device();
    const u = this.user(me.userId);
    if (u.authKey !== hex(req.currentAuthKey)) throw new ApiError('invalid_credentials', 'bad credentials', 401);
    let version: number | undefined;
    if (req.rotation) {
      const cur = this.s.latest(u.userId)?.version ?? 0;
      if (req.rotation.expectedVersion !== cur) throw new ApiError('version_conflict', 'conflict', 412, undefined, cur);
      version = cur + 1;
      this.s.vaults.set(u.userId, [{ version, body: copy(req.rotation.vault), deviceName: me.name, createdAt: new Date(0).toISOString() }]);
    }
    u.authKey = hex(req.newAuthKey);
    u.kdf = req.kdf;
    u.iterations = req.iterations;
    u.wrappedVaultKey = copy(req.newWrappedVaultKey);
    for (const [t, d] of this.s.devices) if (d.userId === u.userId && t !== token) this.s.devices.delete(t);
    return version === undefined ? {} : { version };
  }

  async deleteAccount(authKey: Uint8Array): Promise<void> {
    await this.enter('deleteAccount');
    const [, me] = await this.device();
    const u = this.user(me.userId);
    if (u.authKey !== hex(authKey)) throw new ApiError('invalid_credentials', 'bad credentials', 401);
    this.s.users.delete(u.username);
    this.s.vaults.delete(u.userId);
    this.s.revokeAll(u.userId);
  }

  async getVault(ifNoneMatch?: number | null): Promise<GetVaultResult> {
    await this.enter('getVault');
    const [, me] = await this.device();
    const latest = this.s.latest(me.userId);
    if (!latest) return { status: 'empty' };
    if (ifNoneMatch === latest.version) return { status: 'not_modified' };
    return { status: 'ok', version: latest.version, body: copy(latest.body) };
  }

  async putVault(body: Uint8Array, expected: number | 'none'): Promise<PutVaultResult> {
    await this.enter('putVault');
    const [, me] = await this.device();
    if (this.s.beforePut) await this.s.beforePut();
    const cur = this.s.latest(me.userId)?.version ?? 0;
    if ((expected === 'none' && cur !== 0) || (expected !== 'none' && expected !== cur)) return { status: 'conflict', currentVersion: cur };
    return { status: 'ok', version: this.s.forcePut(me.userId, body, me.name) };
  }

  async listVersions(): Promise<VersionInfo[]> {
    await this.enter('listVersions');
    const [, me] = await this.device();
    return [...(this.s.vaults.get(me.userId) ?? [])]
      .reverse()
      .map((v) => ({ version: v.version, createdAt: v.createdAt, deviceName: v.deviceName, size: v.body.length }));
  }

  async getVersion(version: number): Promise<Uint8Array> {
    await this.enter('getVersion');
    const [, me] = await this.device();
    const v = this.s.vaults.get(me.userId)?.find((x) => x.version === version);
    if (!v) throw new ApiError('not_found', 'version not found', 404);
    return copy(v.body);
  }
}
