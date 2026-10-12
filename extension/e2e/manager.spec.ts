import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/** A tree row by its exact title. */
const row = (page: Page, title: string) => page.locator('.node-row').filter({ has: page.locator('.title', { hasText: new RegExp(`^${title}$`) }) });

test('opens from the popup and shows the synced roots as a tree', async ({ browserA }) => {
  await browserA.bookmarks(async (b) => {
    const work = await b.create({ parentId: '1', title: 'Work' });
    await b.create({ parentId: work.id, title: 'Tracker', url: 'https://tracker.example/' });
    await b.create({ parentId: '1', title: 'Example', url: 'https://example.com/' });
    await b.create({ parentId: '2', title: 'Misc', url: 'https://misc.example/' });
  });
  const popup = await browserA.openPopup();
  const opened = browserA.context.waitForEvent('page');
  await popup.click('#open-manager').catch(() => undefined); // the popup closes itself
  const manager = await opened;
  await manager.waitForURL(/manager\.html$/);

  // Roots are expanded, other folders collapsed.
  await expect(row(manager, 'Bookmarks bar')).toBeVisible();
  await expect(row(manager, 'Other bookmarks')).toBeVisible();
  await expect(row(manager, 'Example')).toContainText('https://example.com/');
  await expect(row(manager, 'Misc')).toBeVisible();
  await expect(row(manager, 'Work').locator('.count')).toHaveText('1');
  await expect(row(manager, 'Tracker')).toHaveCount(0);

  await row(manager, 'Work').locator('.twisty').click();
  await expect(row(manager, 'Tracker')).toBeVisible();
  await expect(row(manager, 'Work').locator('.twisty')).toHaveAttribute('aria-expanded', 'true');
});

test('selects a row on click and opens a bookmark on double-click', async ({ server, browserA }) => {
  await browserA.bookmarks(async (b, base) => {
    await b.create({ parentId: '1', title: 'One', url: `${base}/healthz?one` });
    await b.create({ parentId: '1', title: 'Two', url: `${base}/healthz?two` });
  }, server.url);
  const manager = await browserA.openManager();
  await row(manager, 'One').click();
  await expect(row(manager, 'One')).toHaveClass(/selected/);
  await row(manager, 'Two').click();
  await expect(row(manager, 'Two')).toHaveClass(/selected/);
  await expect(row(manager, 'One')).not.toHaveClass(/selected/);

  const opened = browserA.context.waitForEvent('page');
  await row(manager, 'Two').dblclick();
  await (await opened).waitForURL(/\?two$/);
});

test('refreshes live, keeping expanded folders and the selection', async ({ browserA }) => {
  const workId = await browserA.bookmarks(async (b) => {
    const work = await b.create({ parentId: '1', title: 'Work' });
    await b.create({ parentId: work.id, title: 'Tracker', url: 'https://tracker.example/' });
    const archive = await b.create({ parentId: '1', title: 'Archive' });
    await b.create({ parentId: archive.id, title: 'Old', url: 'https://old.example/' });
    return work.id;
  });
  const manager = await browserA.openManager();
  await row(manager, 'Work').locator('.twisty').click();
  await row(manager, 'Tracker').click();

  // Changes made elsewhere (sync, the browser's own UI) show up by themselves.
  await browserA.bookmarks((b, parentId) => b.create({ parentId, title: 'Wiki', url: 'https://wiki.example/' }), workId);
  await expect(row(manager, 'Wiki')).toBeVisible();
  await expect(row(manager, 'Tracker')).toHaveClass(/selected/);
  await expect(row(manager, 'Old')).toHaveCount(0); // Archive stayed collapsed

  // A removed selected row just disappears.
  await browserA.bookmarks(async (b) => {
    const [tracker] = await b.search({ title: 'Tracker' });
    await b.remove(tracker!.id);
  });
  await expect(row(manager, 'Tracker')).toHaveCount(0);
  await expect(manager.locator('.node-row.selected')).toHaveCount(0);
});

test('shows long titles in full in a tooltip', async ({ browserA }) => {
  const long = 'A very long bookmark title '.repeat(12).trim();
  await browserA.bookmarks((b, title) => b.create({ parentId: '1', title, url: 'https://long.example/' }), long);
  const manager = await browserA.openManager();
  await expect(manager.locator('.node-row[title^="A very long"]')).toHaveAttribute('title', `${long}\nhttps://long.example/`);
});
