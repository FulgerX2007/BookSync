// Builds the Go server once for the whole e2e run.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function globalSetup(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(here, '../..');
  execFileSync('go', ['build', '-o', resolve(here, '../e2e-bin/booksync-server'), './cmd/booksync-server'], { cwd: repo, stdio: 'inherit' });
}
