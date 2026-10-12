// E2E fixtures: a real BookSync server process per test, and Chromium
// profiles with the unpacked e2e build of the extension.
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

/** Use a preinstalled Chromium when Playwright's own download is not available. */
function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  return existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolvePort(addr.port) : reject(new Error('no port'))));
    });
  });
}

export interface SyncServer {
  url: string;
  dir: string;
  dbPath: string;
  stop(): Promise<void>;
}

export async function startServer(): Promise<SyncServer> {
  const dir = mkdtempSync(join(tmpdir(), 'booksync-e2e-server-'));
  const port = await freePort();
  const dbPath = join(dir, 'booksync.db');
  const proc: ChildProcess = spawn(serverBin, [], {
    env: { ...process.env, BOOKSYNC_ADDR: `127.0.0.1:${port}`, BOOKSYNC_DB_PATH: dbPath, BOOKSYNC_LOG_LEVEL: 'warn' },
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
      ...(chromiumPath() ? { executablePath: chromiumPath() } : {}),
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    return new ExtBrowser(context, new URL(worker.url()).host, userDataDir);
  }

  /** The extension's service worker (restarted by Chromium as needed). */
  async worker(): Promise<Worker> {
    return this.context.serviceWorkers().find((w) => w.url().includes(this.extensionId)) ?? (await this.context.waitForEvent('serviceworker'));
  }

  async openOptions(): Promise<Page> {
    const page = await this.context.newPage();
    await page.goto(`chrome-extension://${this.extensionId}/options.html`);
    return page;
  }

  async openPopup(): Promise<Page> {
    const page = await this.context.newPage();
    await page.goto(`chrome-extension://${this.extensionId}/popup.html`);
    return page;
  }

  /** Runs chrome.bookmarks calls inside the extension. */
  async bookmarks<T>(fn: (b: typeof chrome.bookmarks) => Promise<T>): Promise<T> {
    const w = await this.worker();
    return w.evaluate(`(${fn.toString()})(chrome.bookmarks)`) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.context.close();
    rmSync(this.userDataDir, { recursive: true, force: true });
  }
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
  if (await page.locator('#server-url').isVisible()) await connect(page, server);
  await page.click('#tab-login');
  await page.fill('#login-username', username);
  await page.fill('#login-password', password);
  await page.fill('#login-syncid', syncId);
  await page.click('#login-submit');
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
