import { describe, expect, it } from 'vitest';
import { E2E_HOST_PERMISSION, buildManifest, composeManifest, deepMerge } from './manifest.mjs';

describe('deepMerge', () => {
  it('merges nested objects and lets the override replace arrays and scalars', () => {
    const merged = deepMerge({ a: { x: 1, y: [1] }, b: 1 }, { a: { y: [2], z: 3 }, b: 2 });
    expect(merged).toEqual({ a: { x: 1, y: [2], z: 3 }, b: 2 });
  });

  it('does not mutate its inputs', () => {
    const base = { a: { x: 1 } };
    deepMerge(base, { a: { x: 2 } });
    expect(base).toEqual({ a: { x: 1 } });
  });
});

describe('buildManifest', () => {
  it('builds a Chromium manifest with a service worker and no gecko block', () => {
    const m = buildManifest('chromium');
    expect(m.manifest_version).toBe(3);
    expect(m.background).toEqual({ service_worker: 'background.js' });
    expect(m.browser_specific_settings).toBeUndefined();
    expect(m.permissions).toEqual(['bookmarks', 'storage', 'alarms']);
  });

  it('builds a Firefox manifest with background scripts and a gecko id', () => {
    const m = buildManifest('firefox') as {
      background: unknown;
      browser_specific_settings: { gecko: { id: string; data_collection_permissions: unknown } };
    };
    expect(m.background).toEqual({ scripts: ['background.js'] });
    expect(m.browser_specific_settings.gecko.id).toMatch(/@/);
    expect(m.browser_specific_settings.gecko.data_collection_permissions).toBeDefined();
  });

  it('only grants the test host permission in e2e builds', () => {
    expect(buildManifest('chromium').host_permissions).toBeUndefined();
    expect(buildManifest('chromium', { e2e: true }).host_permissions).toEqual([E2E_HOST_PERMISSION]);
  });

  it('stamps the version from package.json', async () => {
    const pkg = (await import('../package.json', { with: { type: 'json' } })).default;
    expect(buildManifest('firefox').version).toBe(pkg.version);
  });
});

describe('composeManifest', () => {
  it('appends to existing host permissions in e2e mode', () => {
    const m = composeManifest({ host_permissions: ['https://a/*'] }, {}, { version: '1.2.3', e2e: true });
    expect(m).toEqual({ host_permissions: ['https://a/*', E2E_HOST_PERMISSION], version: '1.2.3' });
  });
});

describe('packageFileName', () => {
  it('names store zips by target and version', async () => {
    const { packageFileName } = await import('./package.mjs');
    expect(packageFileName('chromium', '1.2.3')).toBe('booksync-chromium-1.2.3.zip');
    expect(packageFileName('firefox', '0.1.0')).toBe('booksync-firefox-0.1.0.zip');
    expect(() => packageFileName('firefox', 'dev')).toThrow();
  });
});
