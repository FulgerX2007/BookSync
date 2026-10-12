// Account flows. All key material is derived and used here, in the
// background; the password never leaves this function scope and the SyncID
// never reaches the server.
import { ApiError, normalizeServerUrl, type ApiClient } from '../api/client';
import { CryptoError } from '../crypto/errors';
import {
  KDF_NAME,
  MIN_ITERATIONS,
  assertKdfParams,
  createVaultKey,
  deriveKeys,
  isValidUsername,
  normalizeUsername,
  rewrapVaultKey,
  unwrapVaultKey,
} from '../crypto/keys';
import { generateSyncId, parseSyncId } from '../crypto/syncid';
import { encryptVault } from '../crypto/vault-cipher';
import type { Session, StateStore } from '../storage/state';
import type { SyncOptions, SyncResult } from '../sync/engine';
import { emergencyKit } from './emergency-kit';
import type { EmergencyKit, StatusView } from './messages';
import { RequestError, requireString, type Router } from './router';
import { statusView } from './scheduler';

export const MIN_PASSWORD_LENGTH = 10;

export interface KdfPolicy {
  /** Iterations for new credentials. */
  iterations: number;
  /** Tests only: accept iteration counts below the minimum. */
  allowWeak: boolean;
}

export const PRODUCTION_KDF: KdfPolicy = { iterations: MIN_ITERATIONS, allowWeak: false };

export interface AccountDeps {
  state: StateStore;
  clientFor: (serverUrl: string, token: () => Promise<string | null>) => ApiClient;
  sync: (opts: SyncOptions) => Promise<SyncResult | undefined>;
  now: () => number;
  kdf?: KdfPolicy;
  /** Refreshes the published status (popup, badge) after account changes. */
  publish?: () => Promise<void>;
}

export class Account {
  private readonly kdf: KdfPolicy;

  constructor(private readonly deps: AccountDeps) {
    this.kdf = deps.kdf ?? PRODUCTION_KDF;
  }

  private derive(username: string, password: string, syncId: Uint8Array, iterations: number) {
    return deriveKeys(username, password, syncId, iterations, { allowWeak: this.kdf.allowWeak });
  }

  private checkKdf(kdf: string, iterations: number): void {
    if (!this.kdf.allowWeak) assertKdfParams(kdf, iterations);
  }

  private async signedIn(): Promise<{ session: Session & { deviceToken: string }; client: ApiClient }> {
    const session = await this.deps.state.getSession();
    if (!session?.deviceToken) throw new RequestError('not_signed_in', 'this browser is not signed in');
    const client = this.deps.clientFor(session.serverUrl, async () => (await this.deps.state.getSession())?.deviceToken ?? null);
    return { session: session as Session & { deviceToken: string }, client };
  }

  async register(req: { serverUrl: string; username: string; password: string; deviceName: string }): Promise<EmergencyKit> {
    const serverUrl = normalizeServerUrl(req.serverUrl);
    const username = validUsername(req.username);
    const password = validPassword(req.password);
    const syncId = generateSyncId();
    const { authKey, kek } = await this.derive(username, password, syncId, this.kdf.iterations);
    const { key, wrapped } = await createVaultKey(kek, username);
    const client = this.deps.clientFor(serverUrl, async () => null);
    const s = await client.register({ username, authKey, kdf: KDF_NAME, iterations: this.kdf.iterations, wrappedVaultKey: wrapped, deviceName: req.deviceName });

    // A new account starts from scratch locally (the browser's bookmarks are kept and uploaded).
    await this.deps.state.clearAccount();
    await this.deps.state.setSession({
      serverUrl,
      username,
      userId: s.userId,
      deviceId: s.deviceId,
      deviceToken: s.deviceToken,
      syncId,
      iterations: this.kdf.iterations,
      wrappedVaultKey: wrapped,
    });
    await this.deps.state.setVaultKey(key);
    await this.deps.sync({ force: true });
    return emergencyKit({ serverUrl, username, syncId, createdAt: this.deps.now() });
  }

  async login(req: { serverUrl: string; username: string; password: string; syncId: string; deviceName: string }): Promise<StatusView> {
    const serverUrl = normalizeServerUrl(req.serverUrl);
    const username = validUsername(req.username);
    const syncId = parseSyncId(req.syncId);
    const client = this.deps.clientFor(serverUrl, async () => null);
    const params = await client.prelogin(username);
    this.checkKdf(params.kdf, params.iterations);
    const { authKey, kek } = await this.derive(username, req.password, syncId, params.iterations);
    const s = await client.login({ username, authKey, deviceName: req.deviceName });
    this.checkKdf(s.kdf, s.iterations);
    let key: CryptoKey;
    try {
      key = await unwrapVaultKey(s.wrappedVaultKey, kek, username);
    } catch (e) {
      if (e instanceof CryptoError) throw new RequestError('invalid_credentials', 'username, password or SyncID is incorrect');
      throw e;
    }

    // Same account on the same server (e.g. after the device was revoked):
    // keep base and id map so the next sync is a guarded merge, not a join.
    const previous = await this.deps.state.getSession();
    const sameAccount = previous !== null && previous.userId === s.userId && previous.serverUrl === serverUrl;
    if (!sameAccount) await this.deps.state.clearAccount();
    await this.deps.state.setSession({
      serverUrl,
      username,
      userId: s.userId,
      deviceId: s.deviceId,
      deviceToken: s.deviceToken,
      syncId,
      iterations: s.iterations,
      wrappedVaultKey: s.wrappedVaultKey,
    });
    await this.deps.state.setVaultKey(key);
    await this.deps.state.updateSync({ nextAttemptAt: 0, lastError: null });
    await this.deps.sync({ force: true });
    return statusView(this.deps.state);
  }

  async logout(): Promise<StatusView> {
    const session = await this.deps.state.getSession();
    if (session?.deviceToken) {
      const client = this.deps.clientFor(session.serverUrl, async () => session.deviceToken);
      // Revoke server-side when possible; sign out locally regardless.
      await client.logout().catch(() => undefined);
    }
    await this.deps.state.clearAccount();
    await this.deps.publish?.();
    return statusView(this.deps.state);
  }

  async changePassword(req: { currentPassword: string; newPassword: string; rotateKeys: boolean }): Promise<{ kit: EmergencyKit | null }> {
    const { session, client } = await this.signedIn();
    const newPassword = validPassword(req.newPassword);
    const { username } = session;
    const current = await this.derive(username, req.currentPassword, session.syncId, session.iterations);
    try {
      // Cheap local check before asking the server.
      await unwrapVaultKey(session.wrappedVaultKey, current.kek, username);
    } catch {
      throw new RequestError('invalid_credentials', 'the current password is incorrect');
    }

    if (!req.rotateKeys) {
      const next = await this.derive(username, newPassword, session.syncId, this.kdf.iterations);
      const newWrapped = await rewrapVaultKey(session.wrappedVaultKey, current.kek, next.kek, username);
      await client.changePassword({
        currentAuthKey: current.authKey,
        newAuthKey: next.authKey,
        kdf: KDF_NAME,
        iterations: this.kdf.iterations,
        newWrappedVaultKey: newWrapped,
      });
      await this.deps.state.setSession({ ...session, iterations: this.kdf.iterations, wrappedVaultKey: newWrapped });
      return { kit: null };
    }

    // Rotation: new SyncID and vault key; the current tree is re-encrypted and
    // replaces the server history in the same request as the new credentials.
    const syncId = generateSyncId();
    const next = await this.derive(username, newPassword, syncId, this.kdf.iterations);
    const { key, wrapped } = await createVaultKey(next.kek, username);
    for (let attempt = 0; attempt < 3; attempt++) {
      const synced = await this.deps.sync({ force: true });
      const st = await this.deps.state.getSync();
      if (synced?.status !== 'ok' || !st.base) throw new RequestError('sync_required', 'BookSync must sync successfully before rotating keys');
      const doc = { ...st.base, seq: st.lastSeq + 1, writtenBy: session.deviceId, writtenAt: this.deps.now() };
      try {
        const res = await client.changePassword({
          currentAuthKey: current.authKey,
          newAuthKey: next.authKey,
          kdf: KDF_NAME,
          iterations: this.kdf.iterations,
          newWrappedVaultKey: wrapped,
          rotation: { expectedVersion: st.version ?? 0, vault: await encryptVault(doc, key, username) },
        });
        await this.deps.state.setSession({ ...session, syncId, iterations: this.kdf.iterations, wrappedVaultKey: wrapped });
        await this.deps.state.setVaultKey(key);
        await this.deps.state.updateSync({ base: doc, version: res.version ?? st.version, lastSeq: doc.seq });
        return { kit: emergencyKit({ serverUrl: session.serverUrl, username, syncId, createdAt: this.deps.now() }) };
      } catch (e) {
        if (e instanceof ApiError && e.code === 'version_conflict') continue; // another device wrote; sync and retry
        throw e;
      }
    }
    throw new RequestError('conflict', 'the vault kept changing; try again');
  }

  async deleteAccount(req: { password: string }): Promise<StatusView> {
    const { session, client } = await this.signedIn();
    const { authKey } = await this.derive(session.username, req.password, session.syncId, session.iterations);
    await client.deleteAccount(authKey);
    await this.deps.state.clearAccount();
    await this.deps.publish?.();
    return statusView(this.deps.state);
  }

  async listDevices() {
    return (await this.signedIn()).client.listDevices();
  }

  async revokeDevice(deviceId: string) {
    const { client } = await this.signedIn();
    await client.revokeDevice(deviceId);
    return client.listDevices();
  }

  async getEmergencyKit(): Promise<EmergencyKit> {
    const session = await this.deps.state.getSession();
    if (!session) throw new RequestError('not_signed_in', 'this browser is not signed in');
    return emergencyKit({ serverUrl: session.serverUrl, username: session.username, syncId: session.syncId, createdAt: this.deps.now() });
  }
}

function validUsername(raw: string): string {
  const u = normalizeUsername(raw ?? '');
  if (!isValidUsername(u)) throw new RequestError('invalid_username', 'username must be 3-64 characters of a-z, 0-9, ".", "_" or "-"');
  return u;
}

function validPassword(pw: string): string {
  if (typeof pw !== 'string' || [...pw].length < MIN_PASSWORD_LENGTH) {
    throw new RequestError('weak_password', `password must have at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return pw;
}

export function registerAccountHandlers(router: Router, account: Account): void {
  router.register('register', (r) =>
    account.register({
      serverUrl: requireString(r, 'serverUrl'),
      username: requireString(r, 'username'),
      password: requireString(r, 'password'),
      deviceName: requireString(r, 'deviceName'),
    }),
  );
  router.register('login', (r) =>
    account.login({
      serverUrl: requireString(r, 'serverUrl'),
      username: requireString(r, 'username'),
      password: requireString(r, 'password'),
      syncId: requireString(r, 'syncId'),
      deviceName: requireString(r, 'deviceName'),
    }),
  );
  router.register('logout', () => account.logout());
  router.register('listDevices', () => account.listDevices());
  router.register('revokeDevice', (r) => account.revokeDevice(requireString(r, 'deviceId')));
  router.register('changePassword', (r) =>
    account.changePassword({
      currentPassword: requireString(r, 'currentPassword'),
      newPassword: requireString(r, 'newPassword'),
      rotateKeys: (r as { rotateKeys?: unknown }).rotateKeys === true,
    }),
  );
  router.register('deleteAccount', (r) => account.deleteAccount({ password: requireString(r, 'password') }));
  router.register('getEmergencyKit', () => account.getEmergencyKit());
}
