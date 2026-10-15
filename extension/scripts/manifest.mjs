// Builds the per-browser manifest from manifests/base.json plus a browser override.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {'chromium' | 'firefox'} Target */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Origin pattern granted up front in e2e builds, so tests never see the permission prompt. */
export const E2E_HOST_PERMISSION = 'http://127.0.0.1/*';

/**
 * Recursively merges plain objects; arrays and scalars in `override` replace those in `base`.
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} override
 * @returns {Record<string, unknown>}
 */
export function deepMerge(base, override) {
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prev = out[key];
    out[key] = isPlainObject(prev) && isPlainObject(value) ? deepMerge(prev, value) : value;
  }
  return out;
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
function readJSON(name) {
  return JSON.parse(readFileSync(join(root, name), 'utf8'));
}

/**
 * Pure manifest construction, separated from file reading for tests.
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} override
 * @param {{ version: string, e2e?: boolean }} opts
 * @returns {Record<string, unknown>}
 */
export function composeManifest(base, override, { version, e2e = false }) {
  const manifest = deepMerge(base, override);
  manifest.version = version;
  if (e2e) {
    const hosts = /** @type {string[]} */ (manifest.host_permissions ?? []);
    manifest.host_permissions = [...hosts, E2E_HOST_PERMISSION];
  }
  return manifest;
}

/**
 * The extension version: BOOKSYNC_VERSION when set (scripts/dist.sh sets it
 * from the release tag), otherwise package.json's, which only dev builds use.
 * Browser stores accept only a plain X.Y.Z.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function extensionVersion(env = process.env) {
  const version = env.BOOKSYNC_VERSION || /** @type {{ version: string }} */ (readJSON('package.json')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`extension version must be X.Y.Z, got "${version}"`);
  return version;
}

/**
 * @param {Target} target
 * @param {{ e2e?: boolean }} [opts]
 * @returns {Record<string, unknown>}
 */
export function buildManifest(target, { e2e = false } = {}) {
  return composeManifest(readJSON('manifests/base.json'), readJSON(`manifests/${target}.json`), {
    version: extensionVersion(),
    e2e,
  });
}
