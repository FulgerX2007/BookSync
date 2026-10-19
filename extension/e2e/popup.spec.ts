import { expect, registerViaUi, status, test, waitForVersionAbove } from './fixtures';

test('shows the sync state and syncs on demand', async ({ server, browserA }) => {
  const options = await browserA.openOptions();
  await registerViaUi(options, server);
  const popup = await browserA.openPopup();
  await expect(popup.locator('#popup-status')).toContainText('Up to date');

  const before = (await status(popup)).version ?? 0;
  await browserA.bookmarks((b) => b.create({ parentId: '1', title: 'From popup test', url: 'https://popup.example/' }));
  await popup.click('#sync-now');
  await waitForVersionAbove(popup, before);
  await expect(popup.locator('#popup-status')).toContainText('Up to date');
});

test('pause stops syncing until resumed', async ({ server, browserA }) => {
  const options = await browserA.openOptions();
  await registerViaUi(options, server);
  const popup = await browserA.openPopup();
  await popup.click('#pause');
  await expect(popup.locator('#popup-status')).toContainText('Paused');
  expect(await browserA.badge()).toBe('‖');

  const before = (await status(popup)).version ?? 0;
  await browserA.bookmarks((b) => b.create({ parentId: '1', title: 'While paused', url: 'https://paused.example/' }));
  await popup.waitForTimeout(4_000); // longer than the 3 s debounce
  expect((await status(popup)).version).toBe(before);

  await popup.click('#resume');
  await waitForVersionAbove(popup, before);
  expect(await browserA.badge()).toBe('');
});

test('asks before a mass deletion and applies it once confirmed', async ({ server, browserA }) => {
  const options = await browserA.openOptions();
  await registerViaUi(options, server);
  await browserA.bookmarks(async (b) => {
    for (let i = 0; i < 40; i++) await b.create({ parentId: '1', title: `bulk ${i}`, url: `https://bulk${i}.example/` });
  });
  const popup = await browserA.openPopup();
  await popup.click('#sync-now');
  const synced = await waitForVersionAbove(popup, 1);

  await browserA.bookmarks(async (b) => {
    const kids = await b.getChildren('1');
    for (const k of kids.slice(0, 30)) await b.remove(k.id);
  });
  await expect(popup.locator('#popup-status')).toContainText('Confirm a large deletion', { timeout: 20_000 });
  await expect(popup.locator('#popup-detail')).toContainText('30 on the server');
  expect(await browserA.badge()).toBe('!');
  expect((await status(popup)).version).toBe(synced);

  await popup.click('#confirm');
  await waitForVersionAbove(popup, synced);
  await expect(popup.locator('#popup-status')).toContainText('Up to date');
  expect(await browserA.badge()).toBe('');
});

test('shows server storage as a bar, and a warning card near the account limit', async ({ server, browserA }) => {
  // Random URLs, so the compressed vault is large enough to fill a 1 KiB limit.
  await browserA.bookmarks(async (b) => {
    for (let i = 0; i < 30; i++) await b.create({ parentId: '1', title: `bulk ${i}`, url: `https://example.com/${crypto.randomUUID()}` });
  });
  const options = await browserA.openOptions();
  await registerViaUi(options, server);

  let popup = await browserA.openPopup();
  await expect(popup.locator('#quota.quota')).toContainText('Storage');
  await expect(popup.locator('#quota')).toContainText('of 10 MB');
  const usage = (await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'getUsage' }))) as { data: { vaultBytes: number; maxVaultBytes: number } };
  const vaultBytes = usage.data.vaultBytes;
  expect(vaultBytes).toBeGreaterThan(1024);
  expect(server.quota('alice')).toContain('(server default)');

  // 85 % of the account's own limit: the warning card.
  server.quota('alice', String(Math.floor(vaultBytes / 0.85)));
  await popup.close();
  popup = await browserA.openPopup();
  await expect(popup.locator('#quota.quota-card.warn')).toContainText('Server storage');
  await expect(popup.locator('#quota')).toContainText('syncing stops');
  await expect(popup.locator('#quota [role="progressbar"]')).toHaveAttribute('aria-valuenow', '85');

  // At the limit: the red card.
  server.quota('alice', String(Math.max(1024, Math.ceil(vaultBytes))));
  await popup.close();
  popup = await browserA.openPopup();
  await expect(popup.locator('#quota.quota-card.full')).toContainText('may not sync');

  // Back to the server default: the quiet bar again.
  server.quota('alice', 'default');
  await popup.close();
  popup = await browserA.openPopup();
  await expect(popup.locator('#quota.quota')).toContainText('of 10 MB');
});
