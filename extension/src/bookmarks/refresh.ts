// Live refresh for the bookmark pages. Bookmark events (from sync, the
// browser's own UI, or our own writes) trigger a re-read after a short
// debounce, but never while the user is in the middle of something: an
// inline rename, a dialog, a drag or one of our own multi-step operations
// holds the gate, and the tree refreshes once when the last hold ends.
// Refreshes never overlap, so an older read cannot overwrite a newer one.

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface RefreshGateOptions {
  refresh: () => Promise<void> | void;
  debounceMs?: number;
  timers?: Timers;
}

/** Ends a hold; with force, refreshes even if no event arrived (e.g. after a failed write). */
export type Release = (force?: boolean) => void;

export interface RefreshGate {
  /** A bookmark event happened. */
  notify(): void;
  /** Defers refreshes until the returned release is called; releasing twice is harmless. */
  hold(): Release;
  readonly held: boolean;
}

export function createRefreshGate({ refresh, debounceMs = 150, timers = realTimers }: RefreshGateOptions): RefreshGate {
  let holds = 0;
  let dirty = false;
  let running = false;
  let handle: unknown = null;

  const run = async (): Promise<void> => {
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    dirty = false;
    try {
      await refresh();
    } finally {
      running = false;
      // Events that arrived during the read get their own refresh.
      if (dirty && holds === 0) schedule();
    }
  };

  const schedule = () => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = timers.setTimeout(() => {
      handle = null;
      if (holds > 0) dirty = true;
      else void run();
    }, debounceMs);
  };

  return {
    notify() {
      if (holds > 0 || running) dirty = true;
      if (holds === 0) schedule();
    },
    hold() {
      holds++;
      if (handle !== null) {
        timers.clearTimeout(handle);
        handle = null;
        dirty = true;
      }
      let released = false;
      return (force = false) => {
        if (released) return;
        released = true;
        holds--;
        if (force) dirty = true;
        if (holds === 0 && dirty) void run();
      };
    },
    get held() {
      return holds > 0;
    },
  };
}
