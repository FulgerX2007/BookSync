import { readFileSync } from 'node:fs';
import { ExtBrowser, PASSWORD, expect, loginViaUi, managerRow, registerViaUi, status, test, waitForVersionAbove, type SyncServer } from './fixtures';
import type { Page } from '@playwright/test';

/** Clicks "Sync now" and waits until the background is idle again. */
async function syncNow(page: Page): Promise<void> {
  await page.click('#sync-now');
  await expect.poll(async () => (await status(page)).status, { timeout: 20_000 }).toBe('ok');
}

/** A registered on the server with some bookmarks, B signed in on the same account. */
async function pair(server: SyncServer, browserA: ExtBrowser, seedB?: (b: ExtBrowser) => Promise<void>) {
  await browserA.bookmarks(async (b) => {
    await b.create({ parentId: '1', title: 'Example', url: 'https://example.com/' });
    const news = await b.create({ parentId: '1', title: 'News' });
    await b.create({ parentId: news.id, title: 'Paper', url: 'https://paper.example/' });
  });
  const pageA = await browserA.openOptions();
  const syncId = await registerViaUi(pageA, server);
  const browserB = await ExtBrowser.launch();
  if (seedB) await seedB(browserB);
  const pageB = await browserB.openOptions();
  await loginViaUi(pageB, server, syncId);
  await expect(pageB.locator('#account-username')).toHaveText('alice');
  await expect.poll(async () => (await status(pageB)).status).toBe('ok');
  await syncNow(pageA);
  return { pageA, browserB, pageB };
}

test('joins a second profile without duplicates', async ({ server, browserA }) => {
  const { browserB } = await pair(server, browserA, async (b) => {
    await b.bookmarks(async (bm) => {
      await bm.create({ parentId: '1', title: 'Example', url: 'https://EXAMPLE.com' });
      await bm.create({ parentId: '1', title: 'Extra', url: 'https://extra.example/' });
    });
  });
  try {
    expect(await browserB.snapshot()).toEqual(await browserA.snapshot());
    const examples = await browserB.bookmarks((b) => b.search({ url: 'https://example.com/' }));
    expect(examples).toHaveLength(1);
    expect(await browserA.bookmarks((b) => b.search({ title: 'Extra' }))).toHaveLength(1);
  } finally {
    await browserB.close();
  }
});

test('propagates creates, renames, moves and deletes', async ({ server, browserA }) => {
  const { pageA, browserB, pageB } = await pair(server, browserA);
  try {
    await browserA.bookmarks(async (b) => {
      const [example] = await b.search({ title: 'Example' });
      const [news] = await b.search({ title: 'News' });
      const [paper] = await b.search({ title: 'Paper' });
      await b.update(example!.id, { title: 'Example (renamed)' });
      await b.move(paper!.id, { parentId: '2' });
      await b.remove(news!.id);
      await b.create({ parentId: '1', title: 'Brand new', url: 'https://new.example/' });
    });
    await syncNow(pageA);
    await syncNow(pageB);
    expect(await browserB.snapshot()).toEqual(await browserA.snapshot());
    expect(await browserB.bookmarks((b) => b.search({ title: 'News' }))).toHaveLength(0);
  } finally {
    await browserB.close();
  }
});

test('keeps a child added to a folder that the other profile deleted', async ({ server, browserA }) => {
  const { pageA, browserB, pageB } = await pair(server, browserA);
  try {
    await pageB.click('#sync-now'); // make sure B is current, then edit offline-ish
    await expect.poll(async () => (await status(pageB)).status).toBe('ok');
    await browserA.bookmarks(async (b) => b.removeTree((await b.search({ title: 'News' }))[0]!.id));
    await syncNow(pageA);
    await browserB.bookmarks(async (b) => b.create({ parentId: (await b.search({ title: 'News' }))[0]!.id, title: 'Rescued', url: 'https://rescued.example/' }));
    await syncNow(pageB);
    await syncNow(pageA);
    for (const browser of [browserA, browserB]) {
      const [rescued] = await browser.bookmarks((b) => b.search({ title: 'Rescued' }));
      expect(rescued?.parentId).toBe('1');
      expect(await browser.bookmarks((b) => b.search({ title: 'News' }))).toHaveLength(0);
    }
    expect(await browserB.snapshot()).toEqual(await browserA.snapshot());
  } finally {
    await browserB.close();
  }
});

test('reorders with real Chromium move semantics and canonicalized URLs, then settles', async ({ server, browserA }) => {
  const { pageA, browserB, pageB } = await pair(server, browserA);
  try {
    await browserA.bookmarks(async (b) => {
      await b.create({ parentId: '1', title: 'Upper', url: 'HTTPS://Upper.EXAMPLE/Path' });
      await b.create({ parentId: '1', title: 'Hash', url: 'https://hash.example/#' });
      await b.create({ parentId: '1', title: 'Idn', url: 'https://bücher.example/' });
    });
    await syncNow(pageA);
    await syncNow(pageB);
    await browserA.bookmarks(async (b) => {
      const kids = await b.getChildren('1');
      await b.move(kids[0]!.id, { parentId: '1', index: kids.length }); // first to last (down)
      const again = await b.getChildren('1');
      await b.move(again[again.length - 1]!.id, { parentId: '1', index: 1 }); // last to second (up)
    });
    await syncNow(pageA);
    await syncNow(pageB);
    expect(await browserB.snapshot()).toEqual(await browserA.snapshot());

    const vA = (await status(pageA)).version;
    const vB = (await status(pageB)).version;
    await syncNow(pageA);
    await syncNow(pageB);
    expect((await status(pageA)).version).toBe(vA);
    expect((await status(pageB)).version).toBe(vB);
  } finally {
    await browserB.close();
  }
});

test('a drag and drop in the manager reaches the other profile, whose open manager refreshes by itself', async ({ server, browserA }) => {
  const { pageA, browserB, pageB } = await pair(server, browserA);
  try {
    const managerB = await browserB.openManager();
    const managerA = await browserA.openManager();
    await managerRow(managerA, 'News').locator('.twisty').click();
    // Paper out of News to the top of the bar: "after" an expanded root is its first child.
    const bar = managerRow(managerA, 'Bookmarks bar');
    const box = (await bar.boundingBox())!;
    await managerRow(managerA, 'Paper').dragTo(bar, { targetPosition: { x: box.width / 3, y: box.height - 3 } });
    await expect.poll(() => browserA.bookmarks(async (b) => (await b.getChildren('1')).map((c) => c.title))).toEqual(['Paper', 'Example', 'News']);

    await syncNow(pageA);
    await syncNow(pageB);
    expect(await browserB.snapshot()).toEqual(await browserA.snapshot());
    await expect(managerRow(managerB, 'Paper')).toBeVisible();
    await expect(managerRow(managerB, 'News').locator('.count')).toHaveText('0');
  } finally {
    await browserB.close();
  }
});

test('uploads a local change by itself, without a manual sync', async ({ server, browserA }) => {
  const page = await browserA.openOptions();
  await registerViaUi(page, server);
  const before = (await status(page)).version ?? 0;
  await browserA.bookmarks((b) => b.create({ parentId: '1', title: 'Automatic', url: 'https://auto.example/' }));
  await waitForVersionAbove(page, before); // debounce (3 s) + upload
});

test('stores only ciphertext on the server', async ({ server, browserA }) => {
  const page = await browserA.openOptions();
  await registerViaUi(page, server);
  const title = 'Unmistakable title 7f3c9a';
  const url = 'https://unmistakable-7f3c9a.example/secret-path';
  await browserA.bookmarks((b, a) => b.create({ parentId: '1', title: a.title, url: a.url }), { title, url });
  await syncNow(page);

  const res = await fetch(`${server.url}/v1/vault`, { headers: { Authorization: `Bearer ${await browserA.deviceToken()}` } });
  const vault = new Uint8Array(await res.arrayBuffer());
  expect(new TextDecoder().decode(vault.subarray(0, 4))).toBe('BSV1');
  expect([vault[16], vault[17]]).not.toEqual([0x1f, 0x8b]); // not a bare gzip stream

  await server.stop();
  for (const file of [server.dbPath, `${server.dbPath}-wal`, `${server.dbPath}-shm`]) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      continue; // WAL/SHM may be gone after a clean shutdown
    }
    for (const needle of [title, url, 'unmistakable-7f3c9a', PASSWORD]) expect(bytes.includes(needle), `${needle} in ${file}`).toBe(false);
  }
});
