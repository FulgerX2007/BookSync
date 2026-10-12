import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { RequestError, Router, requireString } from './router';

describe('Router', () => {
  it('rejects malformed and unknown messages', async () => {
    const r = new Router();
    for (const msg of [null, 'getStatus', 42, {}, { type: 7 }, { type: 'nope' }]) {
      expect(await r.dispatch(msg)).toEqual({ ok: false, error: { code: 'invalid_message', message: expect.any(String) } });
    }
  });

  it('dispatches registered handlers with the full request', async () => {
    const r = new Router();
    r.register('revokeDevice', async (req) => [{ id: req.deviceId, name: 'x', createdAt: '', lastSeenAt: '', current: false }]);
    expect(r.has('revokeDevice')).toBe(true);
    expect(await r.dispatch({ type: 'revokeDevice', deviceId: 'd1' })).toMatchObject({ ok: true, data: [{ id: 'd1' }] });
  });

  it('turns thrown errors into error responses with their code', async () => {
    const r = new Router();
    r.register('listDevices', async () => {
      throw new ApiError('unauthorized', 'signed out');
    });
    r.register('listVersions', async () => {
      throw new Error('boom');
    });
    expect(await r.dispatch({ type: 'listDevices' })).toEqual({ ok: false, error: { code: 'unauthorized', message: 'signed out' } });
    expect(await r.dispatch({ type: 'listVersions' })).toEqual({ ok: false, error: { code: 'internal', message: 'boom' } });
  });

  it('only answers messages from its own extension', () => {
    const r = new Router();
    let listener!: (m: unknown, s: { id?: string }, respond: (x: unknown) => void) => boolean;
    const runtime = { id: 'me', onMessage: { addListener: (l: typeof listener) => (listener = l) } } as unknown as typeof chrome.runtime;
    r.listen(runtime);
    expect(listener({ type: 'getStatus' }, { id: 'someone-else' }, () => undefined)).toBe(false);
    expect(listener({ type: 'getStatus' }, { id: 'me' }, () => undefined)).toBe(true);
  });
});

describe('requireString', () => {
  it('returns present strings and rejects missing or blank ones', () => {
    expect(requireString({ a: 'x' }, 'a')).toBe('x');
    expect(() => requireString({}, 'a')).toThrow(RequestError);
    expect(() => requireString({ a: '  ' }, 'a')).toThrow(RequestError);
    expect(requireString({ a: '' }, 'a', { allowEmpty: true })).toBe('');
  });
});
