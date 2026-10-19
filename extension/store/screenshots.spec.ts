// Store listing images from the real extension against a real server:
//   npm run store:assets   -> store/assets/*.png
// Raw captures of the popup, the manager and the options page are laid out
// on 1280×800 slides (Chrome Web Store, Edge Add-ons, AMO), plus the promo
// tiles and the Edge logo.
import type { Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASSWORD, connect, expect, managerRow, test } from '../e2e/fixtures';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'assets');
const SHOWN_SERVER = 'https://bookmarks.example.com';

test.use({ colorScheme: 'light' });

/**
 * Makes the page read like a real deployment: the local test server's
 * address becomes SHOWN_SERVER, and a local build's version ("dev") goes.
 * Then scrolls to the top.
 */
async function disguiseServer(page: Page, url: string): Promise<void> {
  await page.evaluate(
    ([from, to]) => {
      const fix = (s: string) => s.replaceAll(from!, to!).replace('BookSync dev', 'BookSync');
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) n.nodeValue = fix(n.nodeValue ?? '');
      for (const input of document.querySelectorAll('input')) input.value = fix(input.value);
      window.scrollTo(0, 0);
    },
    [url, SHOWN_SERVER],
  );
}

const png = (buf: Buffer) => `data:image/png;base64,${buf.toString('base64')}`;
const icon = () => `data:image/svg+xml;base64,${readFileSync(join(here, '../icons/icon.svg')).toString('base64')}`;

const STYLE = `
  * { box-sizing: border-box; margin: 0; }
  body { font-family: "Inter", "Segoe UI", system-ui, sans-serif; color: #fff; overflow: hidden;
         background: radial-gradient(circle at 75% 40%, #2b4590 0%, #14204a 45%, #0b1430 100%); }
  .slide { width: 1280px; height: 800px; display: flex; align-items: center; gap: 56px; padding: 0 72px; }
  .copy { flex: 0 0 400px; }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 26px; font-weight: 700; margin-bottom: 36px; }
  .brand img { width: 48px; height: 48px; }
  h1 { font-size: 46px; line-height: 1.12; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 20px; }
  h1 em { font-style: normal; color: #ffc85a; }
  p { font-size: 21px; line-height: 1.5; color: #c9d4f2; }
  .shot { flex: 1; display: flex; justify-content: center; align-items: center; height: 100%; }
  .shot img { max-width: 100%; max-height: 680px; border-radius: 14px; background: #fff;
              box-shadow: 0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.08); }
`;

async function slide(page: Page, file: string, title: string, text: string, shot: Buffer): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setContent(`<style>${STYLE}</style><div class="slide"><div class="copy">
    <div class="brand"><img src="${icon()}">BookSync</div><h1>${title}</h1><p>${text}</p></div>
    <div class="shot"><img src="${png(shot)}"></div></div>`);
  await page.screenshot({ path: join(out, file) });
}

async function tile(page: Page, file: string, width: number, height: number, big: boolean): Promise<void> {
  await page.setViewportSize({ width, height });
  const s = big ? { icon: 200, title: 84, text: 30, gap: 56 } : { icon: 96, title: 40, text: 17, gap: 24 };
  await page.setContent(`<style>${STYLE}
    .tile { width: ${width}px; height: ${height}px; display: flex; align-items: center; justify-content: center; gap: ${s.gap}px; }
    .tile img { width: ${s.icon}px; height: ${s.icon}px; }
    .tile h1 { font-size: ${s.title}px; margin-bottom: ${big ? 12 : 6}px; }
    .tile p { font-size: ${s.text}px; color: #c9d4f2; }
  </style><div class="tile"><img src="${icon()}"><div><h1>BookSync</h1><p>Encrypted bookmark sync,<br>on your own server.</p></div></div>`);
  await page.screenshot({ path: join(out, file) });
}

test('store listing images', async ({ server, browserA }) => {
  test.setTimeout(180_000);
  mkdirSync(out, { recursive: true });

  await browserA.bookmarks(async (b) => {
    const add = (parentId: string, title: string, url?: string) => b.create(url ? { parentId, title, url } : { parentId, title });
    const work = await add('1', 'Work');
    await add(work.id, 'Sprint board', 'https://linear.app/');
    await add(work.id, 'Design system', 'https://www.figma.com/');
    await add(work.id, 'CI dashboard', 'https://github.com/actions');
    const docs = await add(work.id, 'Docs');
    await add(docs.id, 'Go documentation', 'https://go.dev/doc/');
    await add(docs.id, 'MDN Web Docs', 'https://developer.mozilla.org/');
    await add(docs.id, 'Go by Example', 'https://gobyexample.com/');
    const reading = await add('1', 'Reading');
    await add(reading.id, 'Hacker News', 'https://news.ycombinator.com/');
    await add(reading.id, 'The Go Blog', 'https://go.dev/blog/');
    await add('1', 'GitHub', 'https://github.com/');
    await add('1', 'Calendar', 'https://calendar.google.com/');
    const travel = await add('2', 'Travel');
    await add(travel.id, 'Lisbon apartments', 'https://www.airbnb.com/');
    await add(travel.id, 'Train tickets', 'https://www.thetrainline.com/');
    const recipes = await add('2', 'Recipes');
    await add(recipes.id, 'Pasta e fagioli', 'https://www.seriouseats.com/');
    await add('2', 'Go playground', 'https://go.dev/play/');
  });

  // Registration: the emergency kit, then the signed-in options page.
  const options = await browserA.openOptions();
  await options.setViewportSize({ width: 700, height: 440 });
  await connect(options, server);
  await options.click('#tab-register');
  await options.fill('#reg-username', 'alice');
  await options.fill('#reg-password', PASSWORD);
  await options.fill('#reg-password2', PASSWORD);
  await options.click('#reg-submit');
  await expect(options.locator('#kit-syncid')).toBeVisible({ timeout: 30_000 });
  await disguiseServer(options, server.url);
  const kit = await options.screenshot();
  await options.check('#kit-saved');
  await options.click('#kit-continue');
  await expect(options.locator('#account-username')).toHaveText('alice');
  await expect(options.getByText(/synced|up to date/i).first()).toBeVisible({ timeout: 30_000 });
  await options.setViewportSize({ width: 700, height: 1000 });
  await disguiseServer(options, server.url);
  const history = await options.locator('section', { has: options.getByRole('heading', { name: 'History' }) }).boundingBox();
  const account = await options.screenshot({ clip: { x: 0, y: 0, width: 700, height: Math.round(history!.y + history!.height + 12) } });

  // The popup: status, and search.
  const site = await browserA.context.newPage();
  await site.goto(`${server.url}/`);
  const popup = await browserA.openPopup(`?tab=${await browserA.tabIdOf(`${server.url}/`)}`);
  await popup.setViewportSize({ width: 320, height: 520 });
  await expect(popup.locator('#status-app')).not.toContainText('Loading');
  await popup.waitForTimeout(500);
  const search = popup.locator('#search input');
  await search.fill('go');
  await popup.waitForTimeout(500);
  const popupShot = await popup.screenshot({ fullPage: true });

  // The manager with folders open.
  const manager = await browserA.openManager();
  await manager.setViewportSize({ width: 900, height: 620 });
  for (const f of ['Work', 'Docs']) {
    await managerRow(manager, f).locator('.twisty').click();
  }
  await managerRow(manager, 'Go documentation').click();
  const managerShot = await manager.screenshot();

  const page = await browserA.context.newPage();
  await slide(page, 'screenshot-1-popup.png', 'Your bookmarks, <em>everywhere</em>', 'Search every synced bookmark from the toolbar, and save the page you are on in one click.', popupShot);
  await slide(page, 'screenshot-2-manager.png', 'A full bookmark <em>manager</em>', 'Organize folders with drag and drop, rename, move and delete. Changes reach your other browsers within a minute.', managerShot);
  await slide(page, 'screenshot-3-account.png', 'Your server, <em>your data</em>', 'Sync through a BookSync server you run yourself. See your devices and sign any of them out.', account);
  await slide(page, 'screenshot-4-encryption.png', '<em>End-to-end</em> encrypted', 'Bookmarks are encrypted in the browser with your password and SyncID. The server can never read them.', kit);
  await tile(page, 'promo-small-440x280.png', 440, 280, false);
  await tile(page, 'promo-marquee-1400x560.png', 1400, 560, true);
  await page.setViewportSize({ width: 300, height: 300 });
  await page.setContent(`<style>*{margin:0}body{background:transparent}</style><img src="${icon()}" style="width:300px;height:300px">`);
  await page.screenshot({ path: join(out, 'logo-300.png'), omitBackground: true });
});
