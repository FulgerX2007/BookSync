import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

type Listener = (message: unknown, sender: { id?: string }, respond: (r: unknown) => void) => boolean;

describe('background entry on a browser without a bookmarks API (Firefox for Android)', () => {
  it('starts without throwing and answers every page with unsupported_browser', async () => {
    let listener: Listener | undefined;
    // Only onMessage: anything else the entry touched (storage, alarms,
    // IndexedDB, action) would throw here.
    vi.stubGlobal('__BOOKSYNC_TARGET__', 'firefox');
    vi.stubGlobal('browser', { runtime: { id: 'me', onMessage: { addListener: (l: Listener) => (listener = l) } } });

    await import('./index');

    expect(listener).toBeDefined();
    const respond = vi.fn();
    expect(listener!({ type: 'getStatus' }, { id: 'me' }, respond)).toBe(true);
    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith({ ok: false, error: { code: 'unsupported_browser', message: expect.any(String) } });
    });
  });
});
