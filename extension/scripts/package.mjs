// Zips the production builds for store upload (completed in Task 28).
import { execFileSync } from 'node:child_process';

for (const target of ['chromium', 'firefox']) {
  execFileSync('npx', ['web-ext', 'build', '-s', `dist/${target}`, '-a', 'dist/packages', '-n', `booksync-${target}-{version}.zip`, '--overwrite-dest'], {
    stdio: 'inherit',
  });
}
