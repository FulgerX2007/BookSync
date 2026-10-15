// Zips the production builds for store upload (version: see extensionVersion):
//   dist/packages/booksync-chromium-<version>.zip
//   dist/packages/booksync-firefox-<version>.zip
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { extensionVersion } from './manifest.mjs';

export const TARGETS = /** @type {const} */ (['chromium', 'firefox']);

/**
 * @param {'chromium' | 'firefox'} target
 * @param {string} version
 */
export function packageFileName(target, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid extension version ${version}`);
  return `booksync-${target}-${version}.zip`;
}

function main() {
  const version = extensionVersion();
  for (const target of TARGETS) {
    execFileSync('npx', ['web-ext', 'build', '-s', `dist/${target}`, '-a', 'dist/packages', '-n', packageFileName(target, version), '--overwrite-dest'], {
      stdio: 'inherit',
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
