import { afterEach, describe, expect, it, vi } from 'vitest';
import { ext, hasBookmarksApi } from './ext';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ext', () => {
  it('prefers browser over chrome, and throws when neither exists', () => {
    const browser = { runtime: {} };
    vi.stubGlobal('chrome', { runtime: {} });
    vi.stubGlobal('browser', browser);
    expect(ext()).toBe(browser);
    vi.stubGlobal('browser', undefined);
    vi.stubGlobal('chrome', undefined);
    expect(() => ext()).toThrow('WebExtension API not available');
  });
});

describe('hasBookmarksApi', () => {
  it('is true when the browser has a bookmarks API', () => {
    vi.stubGlobal('browser', { bookmarks: { getTree: async () => [] } });
    expect(hasBookmarksApi()).toBe(true);
  });

  it('is false on Firefox for Android, which has no bookmarks namespace', () => {
    vi.stubGlobal('browser', { runtime: {}, storage: {} });
    expect(hasBookmarksApi()).toBe(false);
  });

  it('is false when the namespace exists without its methods', () => {
    vi.stubGlobal('browser', { bookmarks: {} });
    expect(hasBookmarksApi()).toBe(false);
  });
});
