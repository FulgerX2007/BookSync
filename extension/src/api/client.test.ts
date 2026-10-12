import { describe, expect, it } from 'vitest';
import { ApiError, HttpApiClient, fromB64Url, normalizeServerUrl, toB64Url } from './client';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** fetch double: records requests and answers from a queue. */
function mockFetch(...responses: (Response | Error)[]) {
  const requests: Recorded[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const raw = init?.body;
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
      body: typeof raw === 'string' ? JSON.parse(raw) : raw instanceof Uint8Array ? [...raw] : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error('no response queued');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, requests };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });
const err = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json(status, { error: { code, message: code, ...extra } }, headers);

const client = (fetch: ReturnType<typeof mockFetch>, token: string | null = 'bst_tok') =>
  new HttpApiClient('https://sync.example/', () => token, fetch.fn);

describe('normalizeServerUrl', () => {
  it.each([
    ['https://sync.example', 'https://sync.example'],
    ['https://sync.example/', 'https://sync.example'],
    ['https://sync.example/booksync/', 'https://sync.example/booksync'],
    ['http://localhost:8080', 'http://localhost:8080'],
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
  ])('%s → %s', (input, want) => {
    expect(normalizeServerUrl(input)).toBe(want);
  });

  it.each(['http://sync.example', 'ftp://sync.example', 'not a url', 'https://user:pw@sync.example', 'https://sync.example/?x=1'])('rejects %s', (input) => {
    expect(() => normalizeServerUrl(input)).toThrowError(expect.objectContaining({ code: 'insecure_url' }));
  });
});

describe('base64url', () => {
  it('round-trips without padding', () => {
    const b = new Uint8Array([0xfb, 0xff, 0x00, 0x10]);
    expect(toB64Url(b)).toBe('-_8AEA');
    expect(fromB64Url(toB64Url(b))).toEqual(b);
  });
});

describe('HttpApiClient requests', () => {
  it('prelogin is unauthenticated and encodes the username', async () => {
    const f = mockFetch(json(200, { kdf: 'pbkdf2-sha256', iterations: 600000 }));
    expect(await client(f).prelogin('a b')).toEqual({ kdf: 'pbkdf2-sha256', iterations: 600000 });
    expect(f.requests[0]).toMatchObject({ url: 'https://sync.example/v1/auth/prelogin?username=a%20b', method: 'GET' });
    expect(f.requests[0]!.headers.Authorization).toBeUndefined();
  });

  it('register sends binary fields as base64url', async () => {
    const f = mockFetch(json(201, { userId: 'u', deviceId: 'd', deviceToken: 'bst_x' }));
    const res = await client(f, null).register({
      username: 'alice',
      authKey: new Uint8Array([1, 2]),
      kdf: 'pbkdf2-sha256',
      iterations: 600000,
      wrappedVaultKey: new Uint8Array([3]),
      deviceName: 'Chrome',
    });
    expect(res.deviceToken).toBe('bst_x');
    expect(f.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://sync.example/v1/auth/register',
      body: { username: 'alice', authKey: 'AQI', kdf: 'pbkdf2-sha256', iterations: 600000, wrappedVaultKey: 'Aw', deviceName: 'Chrome' },
    });
  });

  it('login decodes the wrapped vault key', async () => {
    const f = mockFetch(json(200, { userId: 'u', deviceId: 'd', deviceToken: 't', wrappedVaultKey: 'AQID', kdf: 'pbkdf2-sha256', iterations: 700000 }));
    const res = await client(f, null).login({ username: 'alice', authKey: new Uint8Array([9]), deviceName: 'x' });
    expect(res.wrappedVaultKey).toEqual(new Uint8Array([1, 2, 3]));
    expect(res.iterations).toBe(700000);
  });

  it('authenticated calls send the bearer token', async () => {
    const f = mockFetch(json(200, []), empty(204), empty(204));
    const c = client(f);
    await c.listDevices();
    await c.revokeDevice('d/1');
    await c.logout();
    expect(f.requests.map((r) => [r.method, r.url, r.headers.Authorization])).toEqual([
      ['GET', 'https://sync.example/v1/devices', 'Bearer bst_tok'],
      ['DELETE', 'https://sync.example/v1/devices/d%2F1', 'Bearer bst_tok'],
      ['POST', 'https://sync.example/v1/auth/logout', 'Bearer bst_tok'],
    ]);
  });

  it('refuses authenticated calls without a token, without touching the network', async () => {
    const f = mockFetch();
    await expect(client(f, null).listDevices()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.requests).toHaveLength(0);
  });

  it('changePassword sends the rotation and returns the new version', async () => {
    const f = mockFetch(json(200, { version: 5 }), empty(204));
    const c = client(f);
    const base = { currentAuthKey: new Uint8Array([1]), newAuthKey: new Uint8Array([2]), kdf: 'pbkdf2-sha256', iterations: 600000, newWrappedVaultKey: new Uint8Array([3]) };
    expect(await c.changePassword({ ...base, rotation: { expectedVersion: 4, vault: new Uint8Array([4]) } })).toEqual({ version: 5 });
    expect(f.requests[0]!.body).toMatchObject({ rotation: { expectedVersion: 4, vault: 'BA' } });
    expect(await c.changePassword(base)).toEqual({});
    expect(f.requests[1]!.body).not.toHaveProperty('rotation');
  });
});

describe('HttpApiClient vault', () => {
  it('handles 200 with ETag, 304 and empty', async () => {
    const f = mockFetch(
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { ETag: '"7"' } }),
      empty(304, { ETag: '"7"' }),
      err(404, 'vault_empty'),
    );
    const c = client(f);
    expect(await c.getVault()).toEqual({ status: 'ok', version: 7, body: new Uint8Array([1, 2, 3]) });
    expect(await c.getVault(7)).toEqual({ status: 'not_modified' });
    expect(f.requests[1]!.headers['If-None-Match']).toBe('"7"');
    expect(await c.getVault(7)).toEqual({ status: 'empty' });
  });

  it('sends the right precondition and maps 412 to a conflict result', async () => {
    const f = mockFetch(json(200, { version: 1 }), json(200, { version: 2 }), err(412, 'version_conflict', { currentVersion: 9 }));
    const c = client(f);
    expect(await c.putVault(new Uint8Array([1]), 'none')).toEqual({ status: 'ok', version: 1 });
    expect(f.requests[0]!.headers).toMatchObject({ 'If-None-Match': '*', 'Content-Type': 'application/octet-stream' });
    expect(f.requests[0]!.body).toEqual([1]);
    expect(await c.putVault(new Uint8Array([2]), 1)).toEqual({ status: 'ok', version: 2 });
    expect(f.requests[1]!.headers['If-Match']).toBe('"1"');
    expect(await c.putVault(new Uint8Array([3]), 1)).toEqual({ status: 'conflict', currentVersion: 9 });
  });

  it('lists and fetches history versions', async () => {
    const f = mockFetch(json(200, [{ version: 2, createdAt: 'x', deviceName: 'd', size: 3 }]), new Response(new Uint8Array([5]), { status: 200 }));
    const c = client(f);
    expect(await c.listVersions()).toHaveLength(1);
    expect(await c.getVersion(2)).toEqual(new Uint8Array([5]));
    expect(f.requests[1]!.url).toBe('https://sync.example/v1/vault/versions/2');
  });
});

describe('HttpApiClient errors', () => {
  const cases: [string, Response | Error, Partial<ApiError>][] = [
    ['network failure', new TypeError('Failed to fetch'), { code: 'network' }],
    ['revoked token', err(401, 'unauthorized'), { code: 'unauthorized', status: 401 }],
    ['wrong password', err(401, 'invalid_credentials'), { code: 'invalid_credentials' }],
    ['rate limited', err(429, 'rate_limited', {}, { 'Retry-After': '7' }), { code: 'rate_limited', retryAfter: 7 }],
    ['rate limited without header', err(429, 'rate_limited'), { code: 'rate_limited', retryAfter: 60 }],
    ['too large', err(413, 'vault_too_large'), { code: 'too_large' }],
    ['registration closed', err(403, 'registration_closed'), { code: 'registration_closed' }],
    ['username taken', err(409, 'username_taken'), { code: 'username_taken' }],
    ['bad request', err(400, 'invalid_request'), { code: 'invalid_request' }],
    ['server error', new Response('oops', { status: 502 }), { code: 'server', status: 502 }],
  ];
  it.each(cases)('maps %s', async (_name, response, want) => {
    const f = mockFetch(response);
    const e = await client(f)
      .listDevices()
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject(want);
  });
});
