import { describe, expect, it } from 'vitest';
import { createRefreshGate, type Timers } from './refresh';

/** Manual timers: run() fires everything due. */
function manualTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  const timers: Timers = {
    setTimeout: (fn) => {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (h) => void pending.delete(h as number),
  };
  const run = () => {
    const due = [...pending.values()];
    pending.clear();
    due.forEach((fn) => fn());
  };
  return {
    timers,
    run,
    get pending() {
      return pending.size;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const t = manualTimers();
  let refreshes = 0;
  let gateResolve: (() => void) | null = null;
  let slow = false;
  const gate = createRefreshGate({
    refresh: () => {
      refreshes++;
      if (slow) return new Promise<void>((r) => (gateResolve = r));
    },
    timers: t.timers,
  });
  return {
    gate,
    t,
    count: () => refreshes,
    slow: (on: boolean) => (slow = on),
    finish: () => gateResolve?.(),
  };
}

describe('createRefreshGate', () => {
  it('coalesces a burst of events into one refresh after the debounce', async () => {
    const s = setup();
    s.gate.notify();
    s.gate.notify();
    s.gate.notify();
    expect(s.count()).toBe(0);
    expect(s.t.pending).toBe(1);
    s.t.run();
    await flush();
    expect(s.count()).toBe(1);
  });

  it('defers refreshes while held and refreshes once on release', async () => {
    const s = setup();
    const release = s.gate.hold();
    expect(s.gate.held).toBe(true);
    s.gate.notify();
    s.gate.notify();
    s.t.run();
    expect(s.count()).toBe(0);
    release();
    await flush();
    expect(s.count()).toBe(1);
    expect(s.gate.held).toBe(false);
  });

  it('turns a refresh already scheduled into a deferred one when a hold starts', async () => {
    const s = setup();
    s.gate.notify();
    const release = s.gate.hold();
    s.t.run();
    expect(s.count()).toBe(0);
    release();
    await flush();
    expect(s.count()).toBe(1);
  });

  it('does not refresh on release when nothing changed, unless forced', async () => {
    const s = setup();
    s.gate.hold()();
    await flush();
    expect(s.count()).toBe(0);
    s.gate.hold()(true);
    await flush();
    expect(s.count()).toBe(1);
  });

  it('waits for the last of nested holds, and ignores a second release', async () => {
    const s = setup();
    const outer = s.gate.hold();
    const inner = s.gate.hold();
    s.gate.notify();
    inner();
    inner();
    await flush();
    expect(s.count()).toBe(0);
    expect(s.gate.held).toBe(true);
    outer();
    await flush();
    expect(s.count()).toBe(1);
  });

  it('never overlaps refreshes: events during a read get one more refresh afterwards', async () => {
    const s = setup();
    s.slow(true);
    s.gate.notify();
    s.t.run();
    expect(s.count()).toBe(1);
    s.gate.notify();
    s.t.run();
    expect(s.count()).toBe(1);
    s.slow(false);
    s.finish();
    await flush();
    s.t.run();
    await flush();
    expect(s.count()).toBe(2);
  });
});
