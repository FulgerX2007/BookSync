import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBookmarks, FakeEvent } from '../../test/fakes/bookmarks';
import { FirefoxAdapter } from '../browser/firefox';
import { defaultSyncState, type Session, type SyncState } from '../storage/state';
import type { SyncOptions, SyncResult } from '../sync/engine';
import { Router } from './router';
import { BACKOFF_MAX_MS, DEBOUNCE_MS, POLL_ALARM, SyncScheduler, registerSyncHandlers, statusView } from './scheduler';

class MemState {
  sync: SyncState = { ...defaultSyncState(), status: 'ok' };
  session: Session | null = null;
  async getSync() {
    return { ...this.sync };
  }
  async updateSync(p: Partial<SyncState>) {
    this.sync = { ...this.sync, ...p };
    return { ...this.sync };
  }
  async getSession() {
    return this.session;
  }
}

class FakeAlarms {
  readonly onAlarm = new FakeEvent();
  readonly created: string[] = [];
  private alarms = new Map<string, chrome.alarms.Alarm>();
  async get(name: string) {
    return this.alarms.get(name);
  }
  async create(name: string, info: chrome.alarms.AlarmCreateInfo) {
    this.created.push(name);
    this.alarms.set(name, { name, scheduledTime: 0, periodInMinutes: info.periodInMinutes, persistAcrossSessions: true } as chrome.alarms.Alarm);
  }
  fire(name: string) {
    this.onAlarm.dispatch({ name, scheduledTime: 0 });
  }
}

const ok: SyncResult = { status: 'ok', uploaded: false, writes: 0, version: 1 };

function setup(syncImpl?: (opts: SyncOptions) => Promise<SyncResult>) {
  const state = new MemState();
  const alarms = new FakeAlarms();
  const change = new FakeEvent();
  const began = new FakeEvent();
  const ended = new FakeEvent();
  const calls: SyncOptions[] = [];
  const publish = vi.fn(async () => undefined);
  let now = 1_000_000;
  const sched: SyncScheduler = new SyncScheduler({
    sync: async (opts) => {
      calls.push(opts);
      return syncImpl ? syncImpl(opts) : ok;
    },
    state,
    changeEvents: [change],
    importEvents: { began, ended },
    alarms,
    publish,
    now: () => now,
    random: () => 0.5, // no jitter
  });
  return { sched, state, alarms, change, began, ended, calls, publish, advanceClock: (ms: number) => (now += ms) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('SyncScheduler', () => {
  it('debounces bursts of bookmark events into one sync', async () => {
    const { sched, change, calls } = setup();
    await sched.start();
    for (let i = 0; i < 5; i++) {
      change.dispatch(); // at t = 0, 100, ..., 400
      await vi.advanceTimersByTimeAsync(100);
    }
    // t = 500; the debounce restarted at t = 400 and fires at 400 + DEBOUNCE_MS.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 101);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(sched.events).toBe(5);
  });

  it('runs single-flight and follows up once after events during a run', async () => {
    let release!: () => void;
    const { sched, change, calls } = setup(
      () =>
        new Promise<SyncResult>((r) => {
          release = () => r(ok);
        }),
    );
    await sched.start();
    const first = sched.requestSync();
    await vi.advanceTimersByTimeAsync(0);
    change.dispatch();
    change.dispatch();
    expect(await sched.requestSync()).toBeUndefined(); // coalesced
    expect(calls).toHaveLength(1);
    release();
    await first;
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
  });

  it('produces exactly one follow-up run for events caused by its own apply', async () => {
    let runs = 0;
    const { sched, calls } = setup(async () => {
      if (runs++ === 0) for (let i = 0; i < 3; i++) sched.onBookmarkEvent();
      return ok;
    });
    await sched.start();
    await sched.requestSync();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    expect(calls).toHaveLength(2);
  });

  it('runs a user request after the current run, with its options', async () => {
    let release!: () => void;
    const { sched, calls } = setup((opts) =>
      opts.force ? Promise.resolve(ok) : new Promise<SyncResult>((r) => (release = () => r(ok))),
    );
    const auto = sched.requestSync();
    await vi.advanceTimersByTimeAsync(0);
    const forced = sched.requestSync({ force: true });
    release();
    await auto;
    expect(await forced).toEqual(ok);
    expect(calls).toEqual([{}, { force: true }]);
  });

  it('backs off exponentially up to the cap, honoring Retry-After, and resets on success', async () => {
    let next: SyncResult = { status: 'error', code: 'network', message: 'down' };
    const { sched, state, advanceClock } = setup(async () => next);
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      await sched.requestSync({ force: true });
      delays.push(state.sync.nextAttemptAt - 1_000_000);
      advanceClock(0);
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);

    next = { status: 'error', code: 'rate_limited', message: 'slow down', retryAfter: 3600 };
    await sched.requestSync({ force: true });
    expect(state.sync.nextAttemptAt - 1_000_000).toBe(3_600_000);

    next = ok;
    await sched.requestSync({ force: true });
    next = { status: 'error', code: 'network', message: 'down' };
    await sched.requestSync({ force: true });
    expect(state.sync.nextAttemptAt - 1_000_000).toBe(30_000);
  });

  it('does not back off for outcomes that need the user', async () => {
    const { sched, state } = setup(async () => ({ status: 'needs_confirmation', pending: { remoteVersion: 1, deletionsToLocal: 0, deletionsToRemote: 30 } }));
    await sched.requestSync();
    expect(state.sync.nextAttemptAt).toBe(0);
  });

  it('restores the status when the engine ran nothing', async () => {
    const results: SyncResult[] = [{ status: 'backoff', until: 1 }, { status: 'signed_out' }];
    const { sched, state, publish } = setup(async () => results.shift()!);
    await sched.requestSync();
    expect(state.sync.status).toBe('ok');
    await sched.requestSync();
    expect(state.sync.status).toBe('signed_out');
    expect(publish).toHaveBeenCalled();
  });

  it('creates the poll alarm once across restarts and syncs when it fires', async () => {
    const { sched, alarms, calls } = setup();
    await sched.start();
    await sched.ensureAlarm();
    await sched.ensureAlarm();
    expect(alarms.created).toEqual([POLL_ALARM]);
    alarms.fire('something-else');
    alarms.fire(POLL_ALARM);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([{}]);
  });

  it('pauses during a bookmark import and syncs once it ends', async () => {
    const { sched, change, began, ended, calls } = setup();
    await sched.start();
    began.dispatch();
    for (let i = 0; i < 10; i++) change.dispatch();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(calls).toHaveLength(0);
    ended.dispatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
  });

  it('starts cleanly with Firefox, which lacks some bookmark events', async () => {
    const fake = new FakeBookmarks('firefox');
    const adapter = new FirefoxAdapter(fake);
    const state = new MemState();
    const sched = new SyncScheduler({
      sync: async () => ok,
      state,
      changeEvents: adapter.changeEvents(),
      importEvents: adapter.importEvents(),
      alarms: new FakeAlarms(),
      publish: async () => undefined,
      now: () => 0,
    });
    await sched.start();
    await fake.addBookmark('toolbar_____', 'x', 'https://x.example/');
    expect(sched.events).toBe(1);
  });
});

describe('sync message handlers', () => {
  function handlers() {
    const env = setup();
    const router = new Router();
    registerSyncHandlers(router, env.sched, env.state);
    return { ...env, router };
  }

  it('pauses and resumes', async () => {
    const { router, state, calls } = handlers();
    const paused = await router.dispatch({ type: 'pauseSync' });
    expect(paused).toMatchObject({ ok: true, data: { paused: true, status: 'paused' } });
    await router.dispatch({ type: 'resumeSync' });
    expect(state.sync.paused).toBe(false);
    expect(calls).toEqual([{ force: true }]);
  });

  it('records that the browser’s own bookmark sync is off, without starting a sync', async () => {
    const { router, state, calls } = handlers();
    expect(await router.dispatch({ type: 'getStatus' })).toMatchObject({ ok: true, data: { builtinSyncOff: false } });
    expect(await router.dispatch({ type: 'confirmBuiltinSyncOff' })).toMatchObject({ ok: true, data: { builtinSyncOff: true } });
    expect(state.sync.builtinSyncOff).toBe(true);
    expect(calls).toEqual([]);
  });

  it('passes the stored pending confirmation and recovery choices to the engine', async () => {
    const { router, state, calls } = handlers();
    const pending = { remoteVersion: 4, deletionsToLocal: 0, deletionsToRemote: 25 };
    state.sync.pendingConfirmation = pending;
    await router.dispatch({ type: 'confirmPendingSync' });
    await router.dispatch({ type: 'useLocalVersion' });
    await router.dispatch({ type: 'acceptServerVersion' });
    await router.dispatch({ type: 'rejoin' });
    await router.dispatch({ type: 'acknowledgeNativeSync' });
    expect(calls).toEqual([
      { force: true, confirmation: pending },
      { force: true, recovery: 'use_local' },
      { force: true, recovery: 'accept_remote' },
      { force: true, rejoin: true },
      { force: true },
    ]);
    expect(state.sync.nativeSyncAck).toBe(true);
  });

  it('reports a server-revoked device as needing to sign in again', async () => {
    const { state } = handlers();
    state.session = {
      serverUrl: 'https://s',
      username: 'alice',
      userId: 'u',
      deviceId: 'd',
      deviceToken: null,
      syncId: new Uint8Array(16),
      iterations: 600000,
      wrappedVaultKey: new Uint8Array(1),
    };
    expect(await statusView(state)).toMatchObject({ signedIn: false, needsReLogin: true, username: 'alice' });
  });
});
