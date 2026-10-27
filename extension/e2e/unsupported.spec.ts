// Firefox for Android has no bookmarks API, so BookSync can't run there. Chromium
// always has one, so each page is opened with the bookmarks namespace hidden
// before its script runs: it must explain the problem instead of hanging on
// "Loading…".
import type { Page } from '@playwright/test';
import { expect, test, type ExtBrowser } from './fixtures';

async function openWithoutBookmarksApi(browser: ExtBrowser, file: string): Promise<Page> {
  const page = await browser.context.newPage();
  await page.addInitScript(() => {
    // Recent Chromium also exposes the `browser` namespace, which ext() prefers.
    const g = globalThis as { chrome?: object; browser?: object };
    for (const ns of [g.chrome, g.browser]) {
      if (ns) Object.defineProperty(ns, 'bookmarks', { value: undefined, configurable: true });
    }
  });
  await page.goto(`chrome-extension://${browser.extensionId}/${file}`);
  return page;
}

for (const file of ['options.html', 'popup.html', 'manager.html']) {
  test(`${file} says BookSync can't run in a browser without a bookmarks API`, async ({ browserA }) => {
    const page = await openWithoutBookmarksApi(browserA, file);
    await expect(page.locator('#unsupported-browser')).toContainText('BookSync can’t run in this browser');
    await expect(page.locator('#unsupported-browser a')).toHaveAttribute('href', /\/docs\/android\.md$/);
    await expect(page.getByText('Loading…')).toHaveCount(0);
  });
}

test('the popup hides search, "Bookmark this page" and the manager button', async ({ browserA }) => {
  const page = await openWithoutBookmarksApi(browserA, 'popup.html');
  await expect(page.locator('#unsupported-browser')).toBeVisible();
  for (const id of ['#search', '#this-page', '#popup-nav']) await expect(page.locator(id)).toBeHidden();
});

test('the manager shows no toolbar', async ({ browserA }) => {
  const page = await openWithoutBookmarksApi(browserA, 'manager.html');
  await expect(page.locator('#unsupported-browser')).toBeVisible();
  await expect(page.locator('#manager-toolbar')).toBeEmpty();
});
