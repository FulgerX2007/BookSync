// Bundles the extension for each target browser.
//   node build.mjs          -> dist/chromium, dist/firefox
//   node build.mjs --e2e    -> dist-e2e/chromium, dist-e2e/firefox (test host permission granted)
import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { buildManifest } from './scripts/manifest.mjs';

const e2e = process.argv.includes('--e2e');
const outRoot = e2e ? 'dist-e2e' : 'dist';
const targets = /** @type {const} */ (['chromium', 'firefox']);

const entryPoints = {
  background: 'src/background/index.ts',
  popup: 'src/ui/popup/popup.ts',
  options: 'src/ui/options/options.ts',
  manager: 'src/ui/manager/manager.ts',
};
// Every page and stylesheet under src/ui is copied flat next to the bundles.
const staticFiles = readdirSync('src/ui', { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.html') || f.endsWith('.css'))
  .map((f) => `src/ui/${f}`);

rmSync(outRoot, { recursive: true, force: true });
for (const target of targets) {
  const outdir = `${outRoot}/${target}`;
  mkdirSync(outdir, { recursive: true });
  await build({
    entryPoints,
    outdir,
    bundle: true,
    format: 'iife',
    target: ['chrome120', 'firefox140'],
    define: { __BOOKSYNC_TARGET__: JSON.stringify(target), __BOOKSYNC_E2E__: String(e2e) },
    logLevel: 'warning',
  });
  for (const file of staticFiles) {
    cpSync(file, `${outdir}/${file.split('/').pop()}`);
  }
  writeFileSync(`${outdir}/manifest.json`, JSON.stringify(buildManifest(target, { e2e }), null, 2) + '\n');
  console.log(`built ${outdir}`);
}
