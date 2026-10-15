import { readFileSync, rmSync } from 'node:fs';
import { formatSyncId, generateSyncId } from '../src/crypto/syncid';
import { ExtBrowser, PASSWORD, expect, freePort, loginViaUi, registerViaUi, startServer, test, waitForVersionAbove } from './fixtures';

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

test('restores an earlier version from the history', async ({ server, browserA }) => {
  const page = await browserA.openOptions();
  await registerViaUi(page, server);
  await browserA.bookmarks((b) => b.create({ parentId: '1', title: 'Keep', url: 'https://keep.example/' }));
  await page.click('#sync-now');
  const v2 = await waitForVersionAbove(page, 1);
  await browserA.bookmarks((b) => b.create({ parentId: '1', title: 'Added later', url: 'https://later.example/' }));
  await page.click('#sync-now');
  await waitForVersionAbove(page, v2);
  await page.reload();

  const rows = page.locator('#history tbody tr');
  await expect(rows).toHaveCount(3); // bootstrap, +Keep, +Added later
  await rows.nth(1).locator('button.restore').click();
  await rows.nth(1).locator('button.confirm-restore').click();

  await expect(page.locator('#history tbody tr')).toHaveCount(4);
  await expect.poll(async () => (await browserA.bookmarks((b) => b.search({ title: 'Added later' }))).length).toBe(0);
  expect(await browserA.bookmarks((b) => b.search({ title: 'Keep' }))).toHaveLength(1);
});

test('tests the connection before continuing', async ({ server, browserA }) => {
  const page = await browserA.openOptions();
  await page.fill('#server-url', server.url);
  await page.click('#test-connection');
  await expect(page.locator('#connect-check')).toHaveText('Connected to BookSync dev · sign-up open');
  await expect(page.locator('#connect-check')).toHaveClass('check ok');
  // Testing does not move on: the address can still be changed.
  await expect(page.locator('#server-url')).toBeVisible();
  await page.click('#connect');
  await expect(page.locator('#connected-server')).toHaveText(server.url);
});

test('shows an unreachable server and stays on the connect step', async ({ browserA }) => {
  const page = await browserA.openOptions();
  await page.fill('#server-url', `http://127.0.0.1:${await freePort()}`);
  await page.click('#test-connection');
  await expect(page.locator('#connect-check')).toContainText('Not reachable');
  await expect(page.locator('#connect-check')).toHaveClass('check bad');
  await page.click('#connect');
  await expect(page.locator('#connect-check')).toContainText('Not reachable');
  await expect(page.locator('#server-url')).toBeVisible();
  await expect(page.locator('#tab-login')).toHaveCount(0);
});

test('opens on Sign in when the server has closed sign-up', async ({ browserA }) => {
  const closed = await startServer({ BOOKSYNC_ALLOW_REGISTRATION: 'false' });
  try {
    const page = await browserA.openOptions();
    await page.fill('#server-url', closed.url);
    await page.click('#test-connection');
    await expect(page.locator('#connect-check')).toHaveText('Connected to BookSync dev · sign-up closed');
    await page.click('#connect');
    await expect(page.locator('#tab-login')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#login-form')).toBeVisible();
    await page.click('#tab-register');
    await expect(page.locator('#registration-closed')).toHaveText('Sign-up is closed on this server.');
  } finally {
    await closed.stop();
    rmSync(closed.dir, { recursive: true, force: true });
  }
});

test('shows the signed-in server as reachable, across re-renders', async ({ server, browserA }) => {
  const page = await browserA.openOptions();
  await registerViaUi(page, server);
  const line = page.locator('#server-check');
  await expect(line).toHaveText('Connected to BookSync dev · sign-up open');
  await expect(page.locator('#server-address')).toHaveText(server.url);
  await expect(page.locator('#server-checked-at')).toContainText('Checked');

  // Sync now re-renders the whole page; the result must survive it.
  await page.click('#sync-now');
  await expect(page.locator('#status')).toContainText('Up to date');
  await page.reload();
  await expect(line).toHaveText('Connected to BookSync dev · sign-up open');
  await page.click('#sync-now');
  await expect(page.locator('#status')).toContainText('Up to date');
  await expect(line).toHaveText('Connected to BookSync dev · sign-up open');
});

test('Check now reports a server that went away', async ({ server, browserA }) => {
  const page = await browserA.openOptions();
  await registerViaUi(page, server);
  await expect(page.locator('#server-check')).toHaveClass('check ok');
  await server.stop();
  await page.click('#check-server');
  await expect(page.locator('#server-check')).toContainText('Not reachable');
  await expect(page.locator('#server-check')).toHaveClass('check bad');
  await expect(page.locator('#check-server')).toBeEnabled();
});
