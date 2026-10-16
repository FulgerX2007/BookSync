// Probes a BookSync server for the options page: is it reachable, is it
// BookSync, and what does it allow (docs/protocol.md §3.2, GET /v1/info).
// Servers without /v1/info fall back to /healthz.
import type { FetchFn } from './client';

export type ServerCheck =
  | { ok: true; version: string | null; registrationOpen: boolean | null; maxVaultBytes: number | null }
  | { ok: false; reason: 'unreachable' | 'not_booksync' | 'storage_unavailable' | 'timeout' };

export interface CheckOptions {
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

/** The optional host-permission pattern that covers a server URL. */
export function serverOrigin(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

/** baseUrl must already be normalized (normalizeServerUrl). */
export async function checkServer(baseUrl: string, { fetchFn = (i, init) => fetch(i, init), timeoutMs = 8000 }: CheckOptions = {}): Promise<ServerCheck> {
  const get = async (path: string): Promise<Response | ServerCheck> => {
    try {
      return await fetchFn(baseUrl + path, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      return { ok: false, reason: (e as { name?: string } | null)?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
  };

  const info = await get('/v1/info');
  if (!(info instanceof Response)) return info;
  if (info.status === 404) {
    // A server from before /v1/info: healthz is all it can tell us.
    const health = await get('/healthz');
    if (!(health instanceof Response)) return health;
    if (health.ok) return { ok: true, version: null, registrationOpen: null, maxVaultBytes: null };
    return { ok: false, reason: health.status === 503 ? 'storage_unavailable' : 'unreachable' };
  }
  // A proxy in front of a stopped server answers 502/503/504, often in HTML:
  // that is "unreachable", not "not BookSync".
  if (!info.ok) return { ok: false, reason: 'unreachable' };

  let body: { service?: unknown; status?: unknown; version?: unknown; registrationOpen?: unknown; maxVaultBytes?: unknown };
  try {
    body = (await info.json()) as typeof body;
  } catch {
    return { ok: false, reason: 'not_booksync' };
  }
  if (body === null || typeof body !== 'object' || body.service !== 'booksync') return { ok: false, reason: 'not_booksync' };
  if (body.status === 'unavailable') return { ok: false, reason: 'storage_unavailable' };
  return {
    ok: true,
    version: typeof body.version === 'string' ? body.version : null,
    registrationOpen: typeof body.registrationOpen === 'boolean' ? body.registrationOpen : null,
    maxVaultBytes: typeof body.maxVaultBytes === 'number' ? body.maxVaultBytes : null,
  };
}

/** The one-line wording the options page shows for a check. */
export function describeServerCheck(check: ServerCheck): { tone: 'ok' | 'bad'; text: string } {
  if (check.ok) {
    const parts = [check.version ? `Connected to BookSync ${check.version}` : 'Connected to BookSync'];
    if (check.registrationOpen === true) parts.push('sign-up open');
    if (check.registrationOpen === false) parts.push('sign-up closed');
    return { tone: 'ok', text: parts.join(' · ') };
  }
  switch (check.reason) {
    case 'unreachable':
      return { tone: 'bad', text: 'Not reachable: check the address, and that the server is running.' };
    case 'timeout':
      return { tone: 'bad', text: 'Not reachable: the server did not answer in time.' };
    case 'not_booksync':
      return { tone: 'bad', text: 'Something answered at that address, but it is not a BookSync server.' };
    case 'storage_unavailable':
      return { tone: 'bad', text: 'The server is up, but its storage is unavailable. Check its logs.' };
  }
}
