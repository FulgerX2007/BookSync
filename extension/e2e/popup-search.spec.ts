import { expect, registerViaUi, status, test, waitForVersionAbove } from './fixtures';

// Bookmarks point at the test server, so opening one loads a real page.

test('finds bookmarks by any part of the title or URL, ignoring case and accents', async ({ server, browserA }) => {
  await browserA.bookmarks(async (b, base) => {
    const dev = await b.create({ parentId: '1', title: 'Dev' });
    await b.create({ parentId: dev.id, title: 'GitHub', url: `${base}/healthz?repo=github` });
    await b.create({ parentId: dev.id, title: 'Docs', url: `${base}/healthz?docs/start` });
    await b.create({ parentId: '2', title: 'Café de Flore', url: `${base}/healthz?flore` });
  }, server.url);
  const popup = await browserA.openPopup();
  const search = popup.locator('#popup-search');
  const results = popup.locator('#popup-results [role=option]');
  await expect(search).toBeFocused();

  await search.fill('hub');
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText('GitHub');
  await expect(results.first()).toContainText('Bookmarks bar › Dev');

  await search.fill('docs/sta');
  await expect(results).toHaveText([/Docs/]);

  await search.fill('CAFE');
  await expect(results).toHaveText([/Café de Flore/]);

  await search.fill('git HUB');
  await expect(results).toHaveText([/GitHub/]);

  await search.fill('git flore');
  await expect(results).toHaveCount(0);
  await expect(popup.locator('#popup-search-note')).toHaveText('No bookmarks match.');

  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(popup.locator('#popup-search-note')).toHaveText('');
});

test('opens the selected result in a new tab with the keyboard', async ({ server, browserA }) => {
  await browserA.bookmarks(async (b, base) => {
    await b.create({ parentId: '1', title: 'Alpha one', url: `${base}/healthz?one` });
    await b.create({ parentId: '1', title: 'Alpha two', url: `${base}/healthz?two` });
  }, server.url);
  const popup = await browserA.openPopup();
  const search = popup.locator('#popup-search');
  await search.fill('alpha');
  await expect(popup.locator('#popup-results [role=option]')).toHaveCount(2);
  await search.press('ArrowDown');
  await expect(popup.locator('#popup-result-1')).toHaveAttribute('aria-selected', 'true');
  const opened = browserA.context.waitForEvent('page');
  // The popup closes itself once the tab is open, which ends the key press early.
  await search.press('Enter').catch(() => undefined);
  const page = await opened;
  await page.waitForURL(/\?two$/);
  await expect.poll(() => popup.isClosed()).toBe(true);
});

test('shows a URL the browser refuses to open as an error', async ({ browserA }) => {
  await browserA.bookmarks(async (b) => {
    await b.create({ parentId: '1', title: 'Bookmarklet', url: 'javascript:void(0)' });
  });
  const popup = await browserA.openPopup();
  await popup.locator('#popup-search').fill('bookmarklet');
  await popup.locator('#popup-results [role=option]').first().click();
  await expect(popup.locator('#popup-search-error')).toContainText('Cannot open javascript:void(0)');
});

test('keeps the query and results across status updates and live bookmark changes', async ({ server, browserA }) => {
  const options = await browserA.openOptions();
  await registerViaUi(options, server);
  await browserA.bookmarks(async (b, base) => {
    await b.create({ parentId: '1', title: 'Keep me', url: `${base}/healthz?keep` });
  }, server.url);
  const popup = await browserA.openPopup();
  const search = popup.locator('#popup-search');
  const results = popup.locator('#popup-results [role=option]');
  await search.fill('keep');
  await expect(results).toHaveCount(1);

  // A sync re-renders the status part of the popup twice.
  const before = (await status(popup)).version ?? 0;
  await popup.click('#sync-now');
  await waitForVersionAbove(popup, before);
  await expect(search).toHaveValue('keep');
  await expect(results).toHaveCount(1);

  // A bookmark added elsewhere shows up without retyping.
  await browserA.bookmarks(async (b, base) => {
    await b.create({ parentId: '2', title: 'Keep me too', url: `${base}/healthz?keep2` });
  }, server.url);
  await expect(results).toHaveCount(2);
});
