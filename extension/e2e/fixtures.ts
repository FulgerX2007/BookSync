// E2E fixtures: a real BookSync server process per test, and Chromium (or,
// with BOOKSYNC_E2E_BROWSER=msedge, Microsoft Edge) profiles with the
// unpacked e2e build of the extension.
import { test as base, chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(here, '../dist-e2e/chromium');
const serverBin = resolve(here, '../e2e-bin/booksync-server');

export const PASSWORD = 'correct horse battery';

/** The browser under test: "chromium" (default) or "msedge" (installed Edge stable). */
export const BROWSER = process.env.BOOKSYNC_E2E_BROWSER ?? 'chromium';
if (BROWSER !== 'chromium' && BROWSER !== 'msedge') throw new Error(`BOOKSYNC_E2E_BROWSER must be chromium or msedge, got "${BROWSER}"`);

/** The root folders' titles as the browser under test names them (the UI shows these). */
export const ROOTS = BROWSER === 'msedge' ? { bar: 'Favorites bar', other: 'Other favorites' } : { bar: 'Bookmarks bar', other: 'Other bookmarks' };

/** Use a preinstalled Chromium when Playwright's own download is not available. */
function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  return existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
}

/**
 * How to launch the browser under test. Without a channel, headless
 * Playwright runs its headless shell, which cannot load extensions; channel
 * "chromium" is the full browser, and "msedge" is the installed Edge.
 */
function launchTarget(): { executablePath: string } | { channel: string } {
  if (BROWSER === 'msedge') return { channel: 'msedge' };
  const executablePath = chromiumPath();
  return executablePath ? { executablePath } : { channel: 'chromium' };
}

export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolvePort(addr.port) : reject(new Error('no port'))));
    });
  });
}

/**
 * Waits until Chromium has installed the extension APIs in a service worker.
 * Playwright reports the worker as soon as it exists; under load its `chrome`
 * object briefly holds only the page-level csi/loadTimes, and an evaluation
 * then fails with "Cannot read properties of undefined (reading 'create')".
 */
async function extensionApiReady(worker: Worker): Promise<Worker> {
  const deadline = Date.now() + 20_000;
  while (!(await worker.evaluate('Boolean(globalThis.chrome && chrome.bookmarks)').catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`the service worker ${worker.url()} never exposed chrome.bookmarks`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return worker;
}

export interface SyncServer {
  url: string;
  dir: string;
  dbPath: string;
  stop(): Promise<void>;
}

/** Starts a server; `env` adds or overrides BOOKSYNC_* settings. */
export async function startServer(env: Record<string, string> = {}): Promise<SyncServer> {
  const dir = mkdtempSync(join(tmpdir(), 'booksync-e2e-server-'));
  const port = await freePort();
  const dbPath = join(dir, 'booksync.db');
  const proc: ChildProcess = spawn(serverBin, [], {
    env: { ...process.env, BOOKSYNC_ADDR: `127.0.0.1:${port}`, BOOKSYNC_DB_PATH: dbPath, BOOKSYNC_LOG_LEVEL: 'warn', ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`${url}/healthz`).then((r) => r.ok).catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    dir,
    dbPath,
    stop: async () => {
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once('exit', r));
        proc.kill('SIGTERM');
        await exited;
      }
    },
  };
}

export class ExtBrowser {
  private constructor(
    readonly context: BrowserContext,
    readonly extensionId: string,
    private readonly userDataDir: string,
  ) {}

  static async launch(): Promise<ExtBrowser> {
    const userDataDir = mkdtempSync(join(tmpdir(), 'booksync-e2e-profile-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      ...launchTarget(),
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    });
    let worker = context.serviceWorkers()[0];
    if (!worker) {
      try {
        worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
      } catch {
        await context.close();
        throw new Error(`the extension's service worker never started: is ${extensionDir} built, and is this a full ${BROWSER} rather than the headless shell?`);
      }
    }
    await extensionApiReady(worker);
    return new ExtBrowser(context, new URL(worker.url()).host, userDataDir);
  }

  /** The extension's service worker (restarted by Chromium as needed). */
  async worker(): Promise<Worker> {
    const worker = this.context.serviceWorkers().find((w) => w.url().includes(this.extensionId)) ?? (await this.context.waitForEvent('serviceworker'));
    return extensionApiReady(worker);
  }

  async openOptions(): Promise<Page> {
    const page = await this.context.newPage();
    await page.goto(`chrome-extension://${this.extensionId}/options.html`);
    return page;
  }

  /** Opens the bookmark manager; `query` may ask it to reveal a node: "?reveal=<id>". */
  async openManager(query = ''): Promise<Page> {
    const page = await this.context.newPage();
    await page.goto(`chrome-extension://${this.extensionId}/manager.html${query}`);
    return page;
  }

  /** Opens popup.html in a tab; `query` (e2e builds) can name the tab to bookmark: "?tab=<id>". */
  async openPopup(query = ''): Promise<Page> {
    const page = await this.context.newPage();
    await page.goto(`chrome-extension://${this.extensionId}/popup.html${query}`);
    return page;
  }

  /** The id of the tab showing `url` (the e2e build may read 127.0.0.1 tab URLs). */
  async tabIdOf(url: string): Promise<number> {
    const w = await this.worker();
    const id = (await w.evaluate(`chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url === ${JSON.stringify(url)})?.id ?? null)`)) as number | null;
    if (id === null) throw new Error(`no tab shows ${url}`);
    return id;
  }

  /**
   * Runs chrome.bookmarks calls inside the extension. fn is serialized, so it
   * cannot close over test variables: pass them as `arg` (JSON).
   */
  async bookmarks<T, A = undefined>(fn: (b: typeof chrome.bookmarks, arg: A) => Promise<T>, arg?: A): Promise<T> {
    const w = await this.worker();
    return w.evaluate(`(${fn.toString()})(chrome.bookmarks, ${JSON.stringify(arg ?? null)})`) as Promise<T>;
  }

  /** Titles and URLs under Bookmarks bar and Other bookmarks, comparable across profiles. */
  async snapshot(): Promise<unknown> {
    return this.bookmarks(async (b) => {
      const [root] = await b.getTree();
      type N = { title: string; url?: string; children?: N[] };
      const strip = (n: N): unknown => (n.url !== undefined ? `${n.title} <${n.url}>` : { [n.title]: (n.children ?? []).map(strip) });
      return (root!.children ?? []).filter((c) => c.id === '1' || c.id === '2').map((c) => (c.children ?? []).map((x) => strip(x as N)));
    });
  }

  /** The device token, read from the extension's IndexedDB. */
  async deviceToken(): Promise<string> {
    const w = await this.worker();
    return w.evaluate(`new Promise((resolve, reject) => {
      const open = indexedDB.open('booksync');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const get = open.result.transaction('kv').objectStore('kv').get('session');
        get.onsuccess = () => resolve(get.result.deviceToken);
        get.onerror = () => reject(get.error);
      };
    })`) as Promise<string>;
  }

  /** The toolbar badge text. */
  async badge(): Promise<string> {
    const w = await this.worker();
    return w.evaluate('chrome.action.getBadgeText({})') as Promise<string>;
  }

  async close(): Promise<void> {
    await this.context.close();
    rmSync(this.userDataDir, { recursive: true, force: true });
  }
}

/** A row of the bookmark manager's tree, by its exact title. */
export function managerRow(page: Page, title: string) {
  return page.locator('.node-row').filter({ has: page.locator('.title', { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
}

/** Fills the connect step of the options page. */
export async function connect(page: Page, server: SyncServer): Promise<void> {
  await page.fill('#server-url', server.url);
  await page.click('#connect');
  await expect(page.locator('#tab-login')).toBeVisible();
}

/** Registers through the UI and returns the SyncID shown once. */
export async function registerViaUi(page: Page, server: SyncServer, username = 'alice', password = PASSWORD): Promise<string> {
  await connect(page, server);
  await page.click('#tab-register');
  await page.fill('#reg-username', username);
  await page.fill('#reg-password', password);
  await page.fill('#reg-password2', password);
  await page.click('#reg-submit');
  const syncId = (await page.locator('#kit-syncid').textContent({ timeout: 30_000 }))!.trim();
  await page.check('#kit-saved');
  await page.click('#kit-continue');
  await expect(page.locator('#account-username')).toHaveText(username);
  return syncId;
}

/** Signs in through the UI (connect step included unless already shown). */
export async function loginViaUi(page: Page, server: SyncServer, syncId: string, username = 'alice', password = PASSWORD): Promise<void> {
  // Either the connect step or the sign-in form, whichever the page shows once it settles.
  await expect(page.locator('#server-url, #tab-login').first()).toBeVisible();
  if (await page.locator('#server-url').isVisible()) await connect(page, server);
  await page.click('#tab-login');
  await page.fill('#login-username', username);
  await page.fill('#login-password', password);
  await page.fill('#login-syncid', syncId);
  await page.click('#login-submit');
}

/** The background's status, read from an extension page. */
export async function status(page: Page): Promise<{ status: string; version: number | null; paused: boolean; pendingConfirmation: unknown }> {
  return page.evaluate(async () => {
    const res = (await chrome.runtime.sendMessage({ type: 'getStatus' })) as { ok: boolean; data: never };
    return res.data;
  });
}

/** Waits until the background reports a server version above `than`. */
export async function waitForVersionAbove(page: Page, than: number): Promise<number> {
  let v = 0;
  await expect.poll(async () => (v = (await status(page)).version ?? 0), { timeout: 20_000 }).toBeGreaterThan(than);
  return v;
}

export const test = base.extend<{ server: SyncServer; browserA: ExtBrowser }>({
  // eslint-disable-next-line no-empty-pattern
  server: async ({}, use) => {
    const s = await startServer();
    await use(s);
    await s.stop();
    rmSync(s.dir, { recursive: true, force: true });
  },
  // eslint-disable-next-line no-empty-pattern
  browserA: async ({}, use) => {
    const b = await ExtBrowser.launch();
    await use(b);
    await b.close();
  },
});

export { expect };
