import { readFileSync } from 'node:fs';
import { formatSyncId, generateSyncId } from '../src/crypto/syncid';
import { ExtBrowser, PASSWORD, expect, loginViaUi, registerViaUi, test } from './fixtures';

test('registers, shows the SyncID once and downloads the emergency kit', async ({ server, browserA }) => {
  const page = await browserA.openOptions();
  await page.fill('#server-url', server.url);
  await page.click('#connect');
  await page.click('#tab-register');
  await page.fill('#reg-username', 'alice');
  await page.fill('#reg-password', PASSWORD);
  await page.fill('#reg-password2', PASSWORD);
  await page.click('#reg-submit');

  const syncId = (await page.locator('#kit-syncid').textContent({ timeout: 30_000 }))!;
  expect(syncId).toMatch(/^BS1(-[0-9A-Z]{4}){7}$/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#kit-download')]);
  expect(download.suggestedFilename()).toBe('booksync-emergency-kit-alice.txt');
  const kit = readFileSync((await download.path())!, 'utf8');
  expect(kit).toContain(syncId);
  expect(kit).not.toContain(PASSWORD);

  await expect(page.locator('#kit-continue')).toBeDisabled();
  await page.check('#kit-saved');
  await page.click('#kit-continue');
  await expect(page.locator('#account-username')).toHaveText('alice');
  await expect(page.locator('#status')).toContainText('Up to date');
});

test('signs out, rejects a wrong SyncID and signs in with the right one', async ({ server, browserA }) => {
  const page = await browserA.openOptions();
  const syncId = await registerViaUi(page, server);
  await page.click('#logout');
  await expect(page.locator('#server-url')).toHaveValue(server.url);

  await loginViaUi(page, server, formatSyncId(generateSyncId()));
  await expect(page.locator('#login-error')).toContainText('incorrect');

  await page.fill('#login-syncid', syncId.slice(0, -1) + (syncId.endsWith('0') ? '1' : '0'));
  await expect(page.locator('#login-syncid-hint')).toContainText('typo');

  await page.fill('#login-syncid', syncId.toLowerCase());
  await expect(page.locator('#login-syncid-hint')).toContainText('Looks right');
  await page.click('#login-submit');
  await expect(page.locator('#account-username')).toHaveText('alice');
});

test('lists devices and signs another browser out', async ({ server, browserA }) => {
  const pageA = await browserA.openOptions();
  const syncId = await registerViaUi(pageA, server);

  const browserB = await ExtBrowser.launch();
  try {
    const pageB = await browserB.openOptions();
    await loginViaUi(pageB, server, syncId);
    await expect(pageB.locator('#account-username')).toHaveText('alice');

    await pageA.reload();
    const devices = pageA.locator('#devices li');
    await expect(devices).toHaveCount(2);
    await expect(pageA.locator('#devices .badge')).toHaveText('this browser');
    await pageA.locator('#devices li button.revoke').click();
    await expect(devices).toHaveCount(1);

    // B finds out on its next sync and asks to sign in again, SyncID pre-filled.
    await pageB.click('#sync-now');
    await expect(pageB.locator('#relogin-note')).toBeVisible();
    await expect(pageB.locator('#login-syncid')).toHaveValue(syncId);
  } finally {
    await browserB.close();
  }
});

test('rotates keys on password change; only the new SyncID works afterwards', async ({ server, browserA }) => {
  const page = await browserA.openOptions();
  const oldSyncId = await registerViaUi(page, server);
  await browserA.bookmarks((b) => b.create({ parentId: '1', title: 'Survives rotation', url: 'https://survives.example/' }));
  await page.click('#sync-now');

  const newPassword = 'a completely new password';
  await page.fill('#pw-current', PASSWORD);
  await page.fill('#pw-new', newPassword);
  await page.fill('#pw-new2', newPassword);
  await page.check('#pw-rotate');
  await page.click('#pw-submit');
  const newSyncId = (await page.locator('#kit-syncid').textContent({ timeout: 30_000 }))!;
  expect(newSyncId).not.toBe(oldSyncId);
  await page.check('#kit-saved');
  await page.click('#kit-continue');

  await page.click('#logout');
  await loginViaUi(page, server, oldSyncId, 'alice', newPassword);
  await expect(page.locator('#login-error')).toContainText('incorrect');
  await page.fill('#login-syncid', newSyncId);
  await page.click('#login-submit');
  await expect(page.locator('#account-username')).toHaveText('alice');
  await expect(page.locator('#status')).toContainText('Up to date');
  const found = await browserA.bookmarks((b) => b.search({ title: 'Survives rotation' }));
  expect(found).toHaveLength(1);
});
