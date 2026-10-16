import { describe, expect, it } from 'vitest';
import type { FetchFn } from './client';
import { checkServer, describeServerCheck, serverOrigin, type ServerCheck } from './server-check';

const BASE = 'https://sync.example.com';
const INFO = { service: 'booksync', protocol: 1, version: '1.2.3', status: 'ok', registrationOpen: true, maxVaultBytes: 10485760 };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const html = (status: number) => new Response('<html><body>Bad Gateway</body></html>', { status, headers: { 'Content-Type': 'text/html' } });

/** A fake fetch answering per path; records the paths it saw. */
function routes(table: Record<string, () => Response | Promise<Response>>): FetchFn & { seen: string[] } {
  const seen: string[] = [];
  const fn = (async (input: string) => {
    const path = input.slice(BASE.length);
    seen.push(path);
    const handler = table[path];
    if (!handler) throw new Error(`unexpected fetch ${input}`);
    return handler();
  }) as FetchFn & { seen: string[] };
  fn.seen = seen;
  return fn;
}

describe('checkServer', () => {
  it('reports the facts from /v1/info', async () => {
    const fetchFn = routes({ '/v1/info': () => json(200, INFO) });
    expect(await checkServer(BASE, { fetchFn })).toEqual({ ok: true, version: '1.2.3', registrationOpen: true, maxVaultBytes: 10485760 });
    expect(fetchFn.seen).toEqual(['/v1/info']);
  });

  it('reports closed sign-up', async () => {
    const fetchFn = routes({ '/v1/info': () => json(200, { ...INFO, registrationOpen: false }) });
    expect(await checkServer(BASE, { fetchFn })).toMatchObject({ ok: true, registrationOpen: false });
  });

  it('accepts an older server without /v1/info through /healthz', async () => {
    const fetchFn = routes({ '/v1/info': () => json(404, { error: { code: 'not_found', message: 'not found' } }), '/healthz': () => json(200, { status: 'ok' }) });
    expect(await checkServer(BASE, { fetchFn })).toEqual({ ok: true, version: null, registrationOpen: null, maxVaultBytes: null });
    expect(fetchFn.seen).toEqual(['/v1/info', '/healthz']);
  });

  it('ignores fields of the wrong type', async () => {
    const fetchFn = routes({ '/v1/info': () => json(200, { service: 'booksync', status: 'ok', version: 7, registrationOpen: 'yes' }) });
    expect(await checkServer(BASE, { fetchFn })).toEqual({ ok: true, version: null, registrationOpen: null, maxVaultBytes: null });
  });

  it('sends no credentials and bypasses the cache', async () => {
    let init: RequestInit | undefined;
    await checkServer(BASE, {
      fetchFn: async (_i, i) => {
        init = i;
        return json(200, INFO);
      },
    });
    expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each<[string, Record<string, () => Response>, ServerCheck]>([
    ['a non-JSON 200', { '/v1/info': () => html(200) }, { ok: false, reason: 'not_booksync' }],
    ['another service', { '/v1/info': () => json(200, { service: 'xbrowsersync' }) }, { ok: false, reason: 'not_booksync' }],
    ['a JSON null body', { '/v1/info': () => json(200, null) }, { ok: false, reason: 'not_booksync' }],
    ['storage down', { '/v1/info': () => json(200, { ...INFO, status: 'unavailable' }) }, { ok: false, reason: 'storage_unavailable' }],
    ['a proxy 502 in HTML', { '/v1/info': () => html(502) }, { ok: false, reason: 'unreachable' }],
    ['an auth wall', { '/v1/info': () => html(401) }, { ok: false, reason: 'unreachable' }],
    ['an old server with storage down', { '/v1/info': () => json(404, {}), '/healthz': () => json(503, {}) }, { ok: false, reason: 'storage_unavailable' }],
    ['an old server answering 500', { '/v1/info': () => json(404, {}), '/healthz': () => json(500, {}) }, { ok: false, reason: 'unreachable' }],
  ])('maps %s', async (_name, table, want) => {
    expect(await checkServer(BASE, { fetchFn: routes(table) })).toEqual(want);
  });

  it('maps a network error to unreachable', async () => {
    const fetchFn: FetchFn = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await checkServer(BASE, { fetchFn })).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('maps a network error on the /healthz fallback to unreachable', async () => {
    const fetchFn: FetchFn = (input) => (input.endsWith('/v1/info') ? Promise.resolve(json(404, {})) : Promise.reject(new TypeError('Failed to fetch')));
    expect(await checkServer(BASE, { fetchFn })).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('times out through the real abort signal', async () => {
    // Never answers; rejects only when the signal fires.
    const fetchFn: FetchFn = (_i, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    expect(await checkServer(BASE, { fetchFn, timeoutMs: 10 })).toEqual({ ok: false, reason: 'timeout' });
  });
});

describe('describeServerCheck', () => {
  it.each<[string, ServerCheck, { tone: 'ok' | 'bad'; text: RegExp }]>([
    ['full info, sign-up open', { ok: true, version: '1.2.3', registrationOpen: true, maxVaultBytes: 1 }, { tone: 'ok', text: /^Connected to BookSync 1\.2\.3 · sign-up open$/ }],
    ['sign-up closed', { ok: true, version: '1.2.3', registrationOpen: false, maxVaultBytes: 1 }, { tone: 'ok', text: /^Connected to BookSync 1\.2\.3 · sign-up closed$/ }],
    ['an older server', { ok: true, version: null, registrationOpen: null, maxVaultBytes: null }, { tone: 'ok', text: /^Connected to BookSync$/ }],
    ['unreachable', { ok: false, reason: 'unreachable' }, { tone: 'bad', text: /^Not reachable/ }],
    ['timeout', { ok: false, reason: 'timeout' }, { tone: 'bad', text: /^Not reachable.*in time/ }],
    ['not BookSync', { ok: false, reason: 'not_booksync' }, { tone: 'bad', text: /not a BookSync server/ }],
    ['storage down', { ok: false, reason: 'storage_unavailable' }, { tone: 'bad', text: /storage is unavailable/ }],
  ])('%s', (_name, check, want) => {
    const got = describeServerCheck(check);
    expect(got.tone).toBe(want.tone);
    expect(got.text).toMatch(want.text);
  });
});

describe('serverOrigin', () => {
  it.each([
    ['https://sync.example.com', 'https://sync.example.com/*'],
    ['https://sync.example.com:8443/booksync', 'https://sync.example.com/*'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1/*'],
    ['http://[::1]:8080', 'http://[::1]/*'],
  ])('%s → %s', (url, want) => {
    expect(serverOrigin(url)).toBe(want);
  });
});
