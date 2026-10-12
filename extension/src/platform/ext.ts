// Single entry point to the WebExtension APIs. Firefox exposes the
// promise-based `browser` namespace; Chromium's MV3 `chrome` namespace also
// returns promises. Resolved lazily so tests can install fakes on globalThis.
export function ext(): typeof chrome {
  const g = globalThis as { browser?: typeof chrome; chrome?: typeof chrome };
  const api = g.browser ?? g.chrome;
  if (!api) {
    throw new Error('WebExtension API not available');
  }
  return api;
}

declare global {
  // Replaced at build time by esbuild's `define`.
  const __BOOKSYNC_TARGET__: 'chromium' | 'firefox';
  const __BOOKSYNC_E2E__: boolean;
}
