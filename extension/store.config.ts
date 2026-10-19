import { defineConfig } from '@playwright/test';

// Store listing images (npm run store:assets); not part of the e2e suite.
export default defineConfig({
  testDir: 'store',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  reporter: 'list',
});
