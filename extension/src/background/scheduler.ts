// Decides when to sync. Runs are single-flight: a request arriving during a
// run marks the scheduler dirty and causes one follow-up run, so events
// produced by our own apply are never lost (the follow-up is a cheap no-op).
//
// MV3 service workers are killed after ~30 s idle, so nothing here relies on
// timers surviving: backoff is persisted as nextAttemptAt (checked by the
// engine) and a 1-minute alarm polls the server.
import type { EventLike } from '../browser/adapter';
import type { StateStore } from '../storage/state';
import type { SyncOptions, SyncResult } from '../sync/engine';
import type { StatusView } from './messages';
import type { Router } from './router';

export const POLL_ALARM = 'booksync-poll';
export const POLL_MINUTES = 1;
export const DEBOUNCE_MS = 3_000;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 15 * 60_000;

interface Alarms {
  get(name: string): Promise<chrome.alarms.Alarm | undefined>;
  create(name: string, info: chrome.alarms.AlarmCreateInfo): Promise<void> | void;
  onAlarm: EventLike;
}

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SchedulerDeps {
  sync: (opts: SyncOptions) => Promise<SyncResult>;
  state: Pick<StateStore, 'getSync' | 'updateSync' | 'getSession'>;
  changeEvents: EventLike[];
  importEvents: { began: EventLike; ended: EventLike } | null;
  alarms: Alarms;
  /** Pushes the current status to the UI (storage.session). */
  publish: () => Promise<void>;
  now: () => number;
  random?: () => number;
  timers?: Timers;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Results after which an automatic retry makes sense. */
const RETRYABLE = new Set<SyncResult['status']>(['error', 'conflict_exhausted']);

export class SyncScheduler {
  /** Bookmark events seen; the engine restarts a run if this changes mid-run. */
  events = 0;
  private inFlight: Promise<SyncResult> | null = null;
  private dirty = false;
  private importing = false;
  private failures = 0;
  private debounceHandle: unknown = null;
  private retryHandle: unknown = null;
  private readonly timers: Timers;

  constructor(private readonly deps: SchedulerDeps) {
    this.timers = deps.timers ?? realTimers;
  }

  /** Registers listeners and the poll alarm. Safe to call on every worker start. */
  async start(): Promise<void> {
    for (const ev of this.deps.changeEvents) ev.addListener(this.onBookmarkEvent);
    if (this.deps.importEvents) {
      this.deps.importEvents.began.addListener(() => {
        this.importing = true;
      });
      this.deps.importEvents.ended.addListener(() => {
        this.importing = false;
        void this.requestSync();
      });
    }
    this.deps.alarms.onAlarm.addListener(((alarm: chrome.alarms.Alarm) => {
      if (alarm.name === POLL_ALARM) void this.requestSync();
    }) as never);
    await this.ensureAlarm();
  }

  /** Alarms may not survive a browser restart; create the poll alarm only if missing. */
  async ensureAlarm(): Promise<void> {
    if (!(await this.deps.alarms.get(POLL_ALARM))) {
      await this.deps.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES, delayInMinutes: POLL_MINUTES });
    }
  }

  readonly eventCount = (): number => this.events;

  /** Pushes the current status to the UI. */
  publish(): Promise<void> {
    return this.deps.publish();
  }

  readonly onBookmarkEvent = (): void => {
    this.events++;
    if (this.importing) return;
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    this.debounce();
  };

  private debounce(): void {
    if (this.debounceHandle !== null) this.timers.clearTimeout(this.debounceHandle);
    this.debounceHandle = this.timers.setTimeout(() => {
      this.debounceHandle = null;
      void this.requestSync();
    }, DEBOUNCE_MS);
  }

  /**
   * Runs a sync. While one is running, automatic requests just mark the
   * scheduler dirty; user-initiated ones (force, confirmation, recovery,
   * rejoin) wait for it and then run with their options.
   */
  async requestSync(opts: SyncOptions = {}): Promise<SyncResult | undefined> {
    const userInitiated = opts.force || opts.confirmation !== undefined || opts.recovery !== undefined || opts.rejoin;
    if (this.inFlight) {
      if (!userInitiated) {
        this.dirty = true;
        return undefined;
      }
      await this.inFlight.catch(() => undefined);
      return this.requestSync(opts);
    }
    this.inFlight = this.execute(opts);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
      if (this.dirty) {
        this.dirty = false;
        this.debounce();
      }
    }
  }

  private async execute(opts: SyncOptions): Promise<SyncResult> {
    const previous = (await this.deps.state.getSync()).status;
    await this.deps.state.updateSync({ status: 'syncing' });
    await this.deps.publish();
    let result: SyncResult;
    try {
      result = await this.deps.sync(opts);
    } catch (e) {
      result = { status: 'error', code: 'internal', message: e instanceof Error ? e.message : String(e) };
      await this.deps.state.updateSync({ status: 'error', lastError: result.message });
    }
    if ((await this.deps.state.getSync()).status === 'syncing') {
      // The engine returned without recording an outcome (nothing ran).
      const restored = result.status === 'paused' || result.status === 'signed_out' ? result.status : previous === 'syncing' ? 'never' : previous;
      await this.deps.state.updateSync({ status: restored });
    }
    await this.handleBackoff(result);
    await this.deps.publish();
    return result;
  }

  private async handleBackoff(result: SyncResult): Promise<void> {
    if (!RETRYABLE.has(result.status)) {
      if (result.status === 'ok') this.failures = 0;
      return;
    }
    this.failures++;
    const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.failures - 1));
    const jitter = 0.8 + (this.deps.random ?? Math.random)() * 0.4;
    const retryAfterMs = result.status === 'error' && result.retryAfter !== undefined ? result.retryAfter * 1000 : 0;
    const delay = Math.max(Math.round(exp * jitter), retryAfterMs);
    await this.deps.state.updateSync({ nextAttemptAt: this.deps.now() + delay });
    // Best effort while the worker lives; the alarm covers the rest.
    if (this.retryHandle !== null) this.timers.clearTimeout(this.retryHandle);
    this.retryHandle = this.timers.setTimeout(() => {
      this.retryHandle = null;
      void this.requestSync();
    }, delay);
  }
}

/** Builds the status the UI shows. */
export async function statusView(state: Pick<StateStore, 'getSync' | 'getSession'>): Promise<StatusView> {
  const [st, session] = await Promise.all([state.getSync(), state.getSession()]);
  return {
    signedIn: Boolean(session?.deviceToken),
    needsReLogin: Boolean(session && !session.deviceToken),
    username: session?.username ?? null,
    serverUrl: session?.serverUrl ?? null,
    status: st.paused ? 'paused' : st.status,
    paused: st.paused,
    lastSyncAt: st.lastSyncAt,
    lastError: st.lastError,
    version: st.version,
    nextAttemptAt: st.nextAttemptAt,
    pendingConfirmation: st.pendingConfirmation,
    nativeSyncAck: st.nativeSyncAck,
    builtinSyncOff: st.builtinSyncOff,
  };
}

/** Registers the sync-related message handlers. */
export function registerSyncHandlers(router: Router, scheduler: SyncScheduler, state: Pick<StateStore, 'getSync' | 'updateSync' | 'getSession'>): void {
  const view = () => statusView(state);
  const run = async (opts: SyncOptions) => {
    await scheduler.requestSync({ force: true, ...opts });
    return view();
  };
  router.register('getStatus', view);
  router.register('syncNow', () => run({}));
  router.register('pauseSync', async () => {
    await state.updateSync({ paused: true });
    await scheduler.publish();
    return view();
  });
  router.register('resumeSync', async () => {
    await state.updateSync({ paused: false });
    return run({});
  });
  router.register('confirmPendingSync', async () => {
    const pending = (await state.getSync()).pendingConfirmation;
    return run(pending ? { confirmation: pending } : {});
  });
  router.register('useLocalVersion', () => run({ recovery: 'use_local' }));
  router.register('acceptServerVersion', () => run({ recovery: 'accept_remote' }));
  router.register('rejoin', () => run({ rejoin: true }));
  router.register('confirmBuiltinSyncOff', async () => {
    await state.updateSync({ builtinSyncOff: true });
    await scheduler.publish();
    return view();
  });
  router.register('acknowledgeNativeSync', async () => {
    await state.updateSync({ nativeSyncAck: true });
    return run({});
  });
}
