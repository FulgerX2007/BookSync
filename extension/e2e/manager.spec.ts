import type { Page } from '@playwright/test';
import { expect, managerRow as row, test } from './fixtures';

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

/** Child titles of a native folder, read through chrome.bookmarks. */
const children = (browser: import('./fixtures').ExtBrowser, parentId: string) =>
  browser.bookmarks(async (b, id) => (await b.getChildren(id)).map((c) => (c.url ? `${c.title} <${c.url}>` : c.title)), parentId);

test('creates a folder whose name sticks through the refresh its creation triggers', async ({ browserA }) => {
  const manager = await browserA.openManager();
  await expect(row(manager, 'Other bookmarks')).toBeVisible();
  await manager.click('#new-folder');
  const input = manager.locator('input.rename');
  await expect(input).toBeFocused();
  await manager.waitForTimeout(600); // well past the refresh debounce
  await input.fill('Projects');
  await input.press('Enter');
  await expect(row(manager, 'Projects')).toBeVisible();
  expect(await children(browserA, '2')).toEqual(['Projects']);
});

test('adds a bookmark into the selected folder and edits it, rejecting a bad URL', async ({ browserA }) => {
  const workId = await browserA.bookmarks(async (b) => (await b.create({ parentId: '1', title: 'Work' })).id);
  const manager = await browserA.openManager();
  await row(manager, 'Work').click();
  await manager.click('#new-bookmark');
  await manager.fill('#edit-title', 'Docs');
  await manager.fill('#edit-url', 'https://docs.example/');
  await manager.click('#edit-save');
  await expect(manager.locator('#edit-dialog')).toHaveCount(0);
  await expect(row(manager, 'Docs')).toHaveClass(/selected/);
  expect(await children(browserA, workId)).toEqual(['Docs <https://docs.example/>']);

  await manager.click('#edit-selected');
  await expect(manager.locator('#edit-url')).toHaveValue('https://docs.example/');
  await manager.fill('#edit-url', 'not a url');
  await manager.click('#edit-save');
  await expect(manager.locator('#edit-error')).toContainText('full URL');
  await expect(manager.locator('#edit-dialog')).toBeVisible();
  await manager.fill('#edit-url', 'https://docs2.example/');
  await manager.fill('#edit-title', 'Docs 2');
  await manager.click('#edit-save');
  await expect(row(manager, 'Docs 2')).toContainText('https://docs2.example/');
  expect(await children(browserA, workId)).toEqual(['Docs 2 <https://docs2.example/>']);
});

test('renames a folder inline from its row action; Escape cancels', async ({ browserA }) => {
  await browserA.bookmarks((b) => b.create({ parentId: '1', title: 'Old name' }));
  const manager = await browserA.openManager();
  await row(manager, 'Old name').hover();
  await row(manager, 'Old name').locator('[data-action=edit]').click();
  await manager.locator('input.rename').fill('Discarded');
  await manager.locator('input.rename').press('Escape');
  await expect(row(manager, 'Old name')).toBeVisible();

  await row(manager, 'Old name').locator('.title').dblclick();
  await manager.locator('input.rename').fill('New name');
  await manager.locator('input.rename').press('Enter');
  await expect(row(manager, 'New name')).toBeVisible();
  expect(await children(browserA, '1')).toEqual(['New name']);
});

test('deletes a folder with its contents only after confirming the counts', async ({ browserA }) => {
  await browserA.bookmarks(async (b) => {
    const work = await b.create({ parentId: '1', title: 'Work' });
    await b.create({ parentId: work.id, title: 'a', url: 'https://a.example/' });
    await b.create({ parentId: work.id, title: 'b', url: 'https://b.example/' });
    const sub = await b.create({ parentId: work.id, title: 'Sub' });
    await b.create({ parentId: sub.id, title: 'c', url: 'https://c.example/' });
    await b.create({ parentId: '1', title: 'Keep', url: 'https://keep.example/' });
  });
  const manager = await browserA.openManager();
  await row(manager, 'Work').hover();
  await row(manager, 'Work').locator('[data-action=delete]').click();
  await expect(manager.locator('#confirm-question')).toHaveText('Delete 2 folders and 3 bookmarks?');
  await manager.click('#confirm-cancel');
  await expect(manager.locator('#confirm-dialog')).toHaveCount(0);
  expect(await children(browserA, '1')).toEqual(['Work', 'Keep <https://keep.example/>']);

  await row(manager, 'Work').hover();
  await row(manager, 'Work').locator('[data-action=delete]').click();
  await manager.click('#confirm-ok');
  await expect(row(manager, 'Work')).toHaveCount(0);
  expect(await children(browserA, '1')).toEqual(['Keep <https://keep.example/>']);
});

test('deletes a single bookmark without asking, and never offers to edit or delete a root', async ({ browserA }) => {
  await browserA.bookmarks((b) => b.create({ parentId: '1', title: 'Gone soon', url: 'https://gone.example/' }));
  const manager = await browserA.openManager();
  await row(manager, 'Gone soon').click();
  await manager.click('#delete-selected');
  await expect(row(manager, 'Gone soon')).toHaveCount(0);
  await expect(manager.locator('#confirm-dialog')).toHaveCount(0);
  expect(await children(browserA, '1')).toEqual([]);

  await row(manager, 'Bookmarks bar').click();
  await expect(manager.locator('#edit-selected')).toBeDisabled();
  await expect(manager.locator('#delete-selected')).toBeDisabled();
  await expect(row(manager, 'Bookmarks bar').locator('.actions')).toHaveCount(0);
});

/** Bookmarks bar: A/B/C/{Deep}, Receipts/{}, Filler 0..39 (so Deep is far down). */
async function deepTree(browser: import('./fixtures').ExtBrowser): Promise<string> {
  return browser.bookmarks(async (b) => {
    for (let i = 0; i < 40; i++) await b.create({ parentId: '1', title: `Filler ${i}`, url: `https://filler${i}.example/` });
    const a = await b.create({ parentId: '1', title: 'A' });
    const bb = await b.create({ parentId: a.id, title: 'B' });
    const c = await b.create({ parentId: bb.id, title: 'C' });
    await b.create({ parentId: '2', title: 'Receipts' });
    return (await b.create({ parentId: c.id, title: 'Deep', url: 'https://deep.example/needle/path' })).id;
  });
}

test('finds a deeply nested bookmark by part of its URL and reveals it in the tree', async ({ browserA }) => {
  await deepTree(browserA);
  const manager = await browserA.openManager();
  await expect(row(manager, 'A')).toBeVisible();
  await manager.fill('#manager-search', 'needle/pa');
  const results = manager.locator('#results .result');
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText('Deep');
  await expect(results.first()).toContainText('Bookmarks bar › A › B › C');

  await results.first().click();
  await expect(manager.locator('#manager-search')).toHaveValue('');
  await expect(row(manager, 'Deep')).toHaveClass(/selected/);
  await expect(row(manager, 'Deep')).toBeInViewport();
});

test('finds folders by name, and Escape returns to the tree', async ({ browserA }) => {
  await deepTree(browserA);
  const manager = await browserA.openManager();
  await manager.fill('#manager-search', 'receip');
  await expect(manager.locator('#results .result')).toHaveText([/Receipts.*Other bookmarks/]);
  await manager.fill('#manager-search', 'nothing like this');
  await expect(manager.locator('#no-results')).toBeVisible();
  await manager.locator('#manager-search').press('Escape');
  await expect(manager.locator('#tree')).toBeVisible();
});

test('opens with ?reveal=<id> showing that node', async ({ browserA }) => {
  const deepId = await deepTree(browserA);
  const manager = await browserA.openManager(`?reveal=${deepId}`);
  await expect(row(manager, 'Deep')).toHaveClass(/selected/);
  await expect(row(manager, 'Deep')).toBeInViewport();
});

/** Drags a row onto another: near its top edge, bottom edge, or middle. */
async function dragOnto(page: Page, source: string, target: string, where: 'before' | 'after' | 'inside'): Promise<void> {
  const box = (await row(page, target).boundingBox())!;
  const y = where === 'before' ? 3 : where === 'after' ? box.height - 3 : box.height / 2;
  await row(page, source).dragTo(row(page, target), { targetPosition: { x: box.width / 3, y } });
}

/** Bookmarks bar: List/{a, b, c, d}, Box/{}, Parent/{Child/{}};  Other bookmarks: z */
async function dndTree(browser: import('./fixtures').ExtBrowser): Promise<{ list: string; box: string; parent: string }> {
  return browser.bookmarks(async (b) => {
    const list = await b.create({ parentId: '1', title: 'List' });
    for (const t of ['a', 'b', 'c', 'd']) await b.create({ parentId: list.id, title: t, url: `https://${t}.example/` });
    const box = await b.create({ parentId: '1', title: 'Box' });
    const parent = await b.create({ parentId: '1', title: 'Parent' });
    await b.create({ parentId: parent.id, title: 'Child' });
    await b.create({ parentId: '2', title: 'z', url: 'https://z.example/' });
    return { list: list.id, box: box.id, parent: parent.id };
  });
}

const titles = (browser: import('./fixtures').ExtBrowser, parentId: string) =>
  browser.bookmarks(async (b, id) => (await b.getChildren(id)).map((c) => c.title), parentId);

test('reorders inside a folder by drag and drop, down and up', async ({ browserA }) => {
  const ids = await dndTree(browserA);
  const manager = await browserA.openManager();
  await row(manager, 'List').locator('.twisty').click();
  await dragOnto(manager, 'a', 'c', 'after');
  await expect.poll(() => titles(browserA, ids.list)).toEqual(['b', 'c', 'a', 'd']);
  await dragOnto(manager, 'd', 'b', 'before');
  await expect.poll(() => titles(browserA, ids.list)).toEqual(['d', 'b', 'c', 'a']);
  // The moved row stays selected.
  await expect(row(manager, 'd')).toHaveClass(/selected/);
});

test('moves into a collapsed folder and into a root', async ({ browserA }) => {
  const ids = await dndTree(browserA);
  const manager = await browserA.openManager();
  await dragOnto(manager, 'z', 'Box', 'inside');
  await expect.poll(() => titles(browserA, ids.box)).toEqual(['z']);
  await expect(row(manager, 'z')).toBeVisible(); // Box opened to show it

  await dragOnto(manager, 'Box', 'Other bookmarks', 'inside');
  await expect.poll(() => titles(browserA, '2')).toEqual(['Box']);
  await expect.poll(() => titles(browserA, '1')).toEqual(['List', 'Parent']);
});

test('drags a multi-selection together, keeping its order', async ({ browserA }) => {
  const ids = await dndTree(browserA);
  const manager = await browserA.openManager();
  await row(manager, 'List').locator('.twisty').click();
  await row(manager, 'd').click();
  await row(manager, 'b').click({ modifiers: ['ControlOrMeta'] });
  await expect(manager.locator('#selection-count')).toHaveText('2 selected');
  await dragOnto(manager, 'd', 'Box', 'inside');
  await expect.poll(() => titles(browserA, ids.box)).toEqual(['b', 'd']);
  await expect.poll(() => titles(browserA, ids.list)).toEqual(['a', 'c']);
  await expect(row(manager, 'b')).toHaveClass(/selected/);
  await expect(row(manager, 'd')).toHaveClass(/selected/);
});

test('selects ranges with Shift and deletes the whole selection after confirming', async ({ browserA }) => {
  const ids = await dndTree(browserA);
  const manager = await browserA.openManager();
  await row(manager, 'List').locator('.twisty').click();
  await row(manager, 'a').click();
  await row(manager, 'c').click({ modifiers: ['Shift'] });
  await expect(manager.locator('#selection-count')).toHaveText('3 selected');
  await manager.click('#delete-selected');
  await expect(manager.locator('#confirm-question')).toHaveText('Delete 3 bookmarks?');
  await manager.click('#confirm-ok');
  await expect.poll(() => titles(browserA, ids.list)).toEqual(['d']);
});

test('refuses to drop a folder into its own child', async ({ browserA }) => {
  const ids = await dndTree(browserA);
  const manager = await browserA.openManager();
  await row(manager, 'Parent').locator('.twisty').click();
  await dragOnto(manager, 'Parent', 'Child', 'inside');
  await manager.waitForTimeout(500);
  expect(await titles(browserA, ids.parent)).toEqual(['Child']);
  expect(await titles(browserA, '1')).toEqual(['List', 'Box', 'Parent']);
});
