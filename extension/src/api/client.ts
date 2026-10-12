// Typed client for the BookSync server API (docs/protocol.md §3).

export type ApiErrorCode =
  | 'unauthorized' // device token missing, revoked or expired
  | 'invalid_credentials' // wrong password or SyncID
  | 'rate_limited'
  | 'version_conflict'
  | 'too_large'
  | 'registration_closed'
  | 'username_taken'
  | 'invalid_request'
  | 'not_found'
  | 'insecure_url'
  | 'network'
  | 'server';

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status = 0,
    /** Seconds, for rate_limited. */
    readonly retryAfter?: number,
    /** For version_conflict. */
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface KdfParams {
  kdf: string;
  iterations: number;
}

export interface Session {
  userId: string;
  deviceId: string;
  deviceToken: string;
}

export interface LoginSession extends Session, KdfParams {
  wrappedVaultKey: Uint8Array;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface VersionInfo {
  version: number;
  createdAt: string;
  deviceName: string;
  size: number;
}

export type GetVaultResult = { status: 'ok'; version: number; body: Uint8Array } | { status: 'not_modified' } | { status: 'empty' };

export type PutVaultResult = { status: 'ok'; version: number } | { status: 'conflict'; currentVersion: number };

export interface RegisterRequest extends KdfParams {
  username: string;
  authKey: Uint8Array;
  wrappedVaultKey: Uint8Array;
  deviceName: string;
}

export interface ChangePasswordRequest extends KdfParams {
  currentAuthKey: Uint8Array;
  newAuthKey: Uint8Array;
  newWrappedVaultKey: Uint8Array;
  rotation?: { expectedVersion: number; vault: Uint8Array };
}

export interface ApiClient {
  prelogin(username: string): Promise<KdfParams>;
  register(req: RegisterRequest): Promise<Session>;
  login(req: { username: string; authKey: Uint8Array; deviceName: string }): Promise<LoginSession>;
  logout(): Promise<void>;
  listDevices(): Promise<DeviceInfo[]>;
  revokeDevice(id: string): Promise<void>;
  /** Resolves with the new vault version when the request carried a rotation. */
  changePassword(req: ChangePasswordRequest): Promise<{ version?: number }>;
  deleteAccount(authKey: Uint8Array): Promise<void>;
  /** ifNoneMatch: the version this device already has. */
  getVault(ifNoneMatch?: number | null): Promise<GetVaultResult>;
  /** expected: the version merged against, or 'none' when creating the first vault. */
  putVault(body: Uint8Array, expected: number | 'none'): Promise<PutVaultResult>;
  listVersions(): Promise<VersionInfo[]>;
  getVersion(version: number): Promise<Uint8Array>;
}

export function toB64Url(b: Uint8Array): string {
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromB64Url(s: string): Uint8Array {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Validates and normalizes a server URL: HTTPS only, except plain HTTP to
 * this machine for development. Returns the origin plus path, without a
 * trailing slash.
 */
export function normalizeServerUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ApiError('insecure_url', 'not a valid URL');
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new ApiError('insecure_url', 'the server must use HTTPS');
  }
  if (u.username || u.password || u.search || u.hash) throw new ApiError('insecure_url', 'the server URL must not contain credentials, a query or a fragment');
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

const etag = (v: number) => `"${v}"`;
const parseETag = (h: string | null): number | undefined => {
  const m = h?.match(/^"(\d+)"$/);
  return m ? Number(m[1]) : undefined;
};

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpApiClient implements ApiClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly getToken: () => string | null | Promise<string | null>,
    private readonly fetchFn: FetchFn = (i, init) => fetch(i, init),
    private readonly timeoutMs = 60_000,
  ) {
    this.baseUrl = normalizeServerUrl(baseUrl);
  }

  async prelogin(username: string): Promise<KdfParams> {
    return this.json('GET', `/v1/auth/prelogin?username=${encodeURIComponent(username)}`, { auth: false });
  }

  async register(req: RegisterRequest): Promise<Session> {
    return this.json('POST', '/v1/auth/register', {
      auth: false,
      body: {
        username: req.username,
        authKey: toB64Url(req.authKey),
        kdf: req.kdf,
        iterations: req.iterations,
        wrappedVaultKey: toB64Url(req.wrappedVaultKey),
        deviceName: req.deviceName,
      },
    });
  }

  async login(req: { username: string; authKey: Uint8Array; deviceName: string }): Promise<LoginSession> {
    const res = await this.json<Omit<LoginSession, 'wrappedVaultKey'> & { wrappedVaultKey: string }>('POST', '/v1/auth/login', {
      auth: false,
      body: { username: req.username, authKey: toB64Url(req.authKey), deviceName: req.deviceName },
    });
    return { ...res, wrappedVaultKey: fromB64Url(res.wrappedVaultKey) };
  }

  async logout(): Promise<void> {
    await this.send('POST', '/v1/auth/logout');
  }

  async listDevices(): Promise<DeviceInfo[]> {
    return this.json('GET', '/v1/devices');
  }

  async revokeDevice(id: string): Promise<void> {
    await this.send('DELETE', `/v1/devices/${encodeURIComponent(id)}`);
  }

  async changePassword(req: ChangePasswordRequest): Promise<{ version?: number }> {
    const res = await this.send('POST', '/v1/account/password', {
      body: {
        currentAuthKey: toB64Url(req.currentAuthKey),
        newAuthKey: toB64Url(req.newAuthKey),
        kdf: req.kdf,
        iterations: req.iterations,
        newWrappedVaultKey: toB64Url(req.newWrappedVaultKey),
        ...(req.rotation ? { rotation: { expectedVersion: req.rotation.expectedVersion, vault: toB64Url(req.rotation.vault) } } : {}),
      },
    });
    return res.status === 204 ? {} : ((await res.json()) as { version: number });
  }

  async deleteAccount(authKey: Uint8Array): Promise<void> {
    await this.send('POST', '/v1/account/delete', { body: { authKey: toB64Url(authKey) } });
  }

  async getVault(ifNoneMatch?: number | null): Promise<GetVaultResult> {
    const headers: Record<string, string> = ifNoneMatch ? { 'If-None-Match': etag(ifNoneMatch) } : {};
    const res = await this.send('GET', '/v1/vault', { headers, accept: [304, 404] });
    if (res.status === 304) return { status: 'not_modified' };
    if (res.status === 404) {
      const code = await errorCode(res);
      if (code === 'vault_empty') return { status: 'empty' };
      throw new ApiError('not_found', 'vault not found', 404);
    }
    const version = parseETag(res.headers.get('ETag'));
    if (version === undefined) throw new ApiError('server', 'vault response without a version', res.status);
    return { status: 'ok', version, body: new Uint8Array(await res.arrayBuffer()) };
  }

  async putVault(body: Uint8Array, expected: number | 'none'): Promise<PutVaultResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      ...(expected === 'none' ? { 'If-None-Match': '*' } : { 'If-Match': etag(expected) }),
    };
    try {
      const res = await this.send('PUT', '/v1/vault', { headers, raw: body });
      return { status: 'ok', version: ((await res.json()) as { version: number }).version };
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') return { status: 'conflict', currentVersion: e.currentVersion ?? 0 };
      throw e;
    }
  }

  async listVersions(): Promise<VersionInfo[]> {
    return this.json('GET', '/v1/vault/versions');
  }

  async getVersion(version: number): Promise<Uint8Array> {
    const res = await this.send('GET', `/v1/vault/versions/${version}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async json<T>(method: string, path: string, opts: SendOptions = {}): Promise<T> {
    const res = await this.send(method, path, opts);
    return (await res.json()) as T;
  }

  private async send(method: string, path: string, opts: SendOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.auth !== false) {
      const token = await this.getToken();
      if (!token) throw new ApiError('unauthorized', 'this device is signed out');
      headers.Authorization = `Bearer ${token}`;
    }
    let body: BodyInit | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    } else if (opts.raw) {
      body = new Uint8Array(opts.raw);
    }
    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ApiError('network', `could not reach the server: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.ok || opts.accept?.includes(res.status)) return res;
    throw await toApiError(res);
  }
}

interface SendOptions {
  auth?: boolean;
  body?: unknown;
  raw?: Uint8Array;
  headers?: Record<string, string>;
  /** Non-2xx statuses the caller handles itself. */
  accept?: number[];
}

async function errorBody(res: Response): Promise<{ code?: string; message?: string; currentVersion?: number }> {
  try {
    const parsed = (await res.json()) as { error?: { code?: string; message?: string; currentVersion?: number } };
    return parsed.error ?? {};
  } catch {
    return {};
  }
}

async function errorCode(res: Response): Promise<string | undefined> {
  return (await errorBody(res)).code;
}

async function toApiError(res: Response): Promise<ApiError> {
  const err = await errorBody(res);
  const msg = err.message ?? `server returned ${res.status}`;
  switch (res.status) {
    case 400:
      return new ApiError('invalid_request', msg, 400);
    case 401:
      return new ApiError(err.code === 'invalid_credentials' ? 'invalid_credentials' : 'unauthorized', msg, 401);
    case 403:
      return new ApiError(err.code === 'registration_closed' ? 'registration_closed' : 'server', msg, 403);
    case 404:
      return new ApiError('not_found', msg, 404);
    case 409:
      return new ApiError('username_taken', msg, 409);
    case 412:
      return new ApiError('version_conflict', msg, 412, undefined, err.currentVersion ?? 0);
    case 413:
      return new ApiError('too_large', msg, 413);
    case 429: {
      const after = Number(res.headers.get('Retry-After'));
      return new ApiError('rate_limited', msg, 429, Number.isFinite(after) && after > 0 ? after : 60);
    }
    default:
      return new ApiError('server', msg, res.status);
  }
}
