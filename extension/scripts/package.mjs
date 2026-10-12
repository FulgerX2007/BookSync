// Zips the production builds for store upload:
//   dist/packages/booksync-chromium-<version>.zip
//   dist/packages/booksync-firefox-<version>.zip
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const target of TARGETS) {
    execFileSync('npx', ['web-ext', 'build', '-s', `dist/${target}`, '-a', 'dist/packages', '-n', packageFileName(target, version), '--overwrite-dest'], {
      stdio: 'inherit',
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
