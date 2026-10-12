// One sync run: the "Sync algorithm" of the plan (steps 0-9).
//
// Invariants:
//  * base advances only after both the browser and the server hold the
//    merged tree, so any failure just re-merges next time;
//  * every browser write is mirrored in the id map immediately, and
//    pendingApply lets a restarted run rebind what an interrupted run created;
//  * user edits made while a run is in flight restart the run instead of
//    being overwritten;
//  * the encrypted seq never goes backwards.
import { ApiError, type ApiClient } from '../api/client';
import { CryptoError } from '../crypto/errors';
import { decryptVault, encryptVault } from '../crypto/vault-cipher';
import { VaultDocError, emptyDoc, treesEqual, type VaultDoc } from '../model/vault';
import { ConcurrentEditError, applyOps, planOps, pruneSkipped, rebindPending } from '../browser/apply';
import type { BookmarksAdapter } from '../browser/adapter';
import { project } from '../browser/projection';
import type { PendingConfirmation, StateStore } from '../storage/state';
import { firstSync } from './first-sync';
import { confirmationCovers, guardCheck } from './guard';
import { merge3 } from './merge';

export const MAX_ATTEMPTS = 3;

export interface SyncDeps {
  api: ApiClient;
  adapter: BookmarksAdapter;
  state: StateStore;
  now: () => number;
  /** Count of bookmark events seen so far; a change mid-run means the user edited. */
  eventCount: () => number;
}

export interface SyncOptions {
  /** The pending summary the user confirmed. */
  confirmation?: PendingConfirmation;
  /** Way out of rollback_detected. */
  recovery?: 'use_local' | 'accept_remote';
  /** Way out of roots_changed: re-pin roots and join again (never deletes). */
  rejoin?: boolean;
  /** User-initiated: ignore pause and backoff. */
  force?: boolean;
}

export type SyncResult =
  | { status: 'ok'; uploaded: boolean; writes: number; version: number | null }
  | { status: 'needs_confirmation'; pending: PendingConfirmation }
  | { status: 'rollback_detected'; remoteSeq: number | null; lastSeq: number }
  | { status: 'conflict_exhausted' }
  | { status: 'roots_changed' }
  | { status: 'native_sync_detected' }
  | { status: 'signed_out' }
  | { status: 'paused' }
  | { status: 'backoff'; until: number }
  | { status: 'error'; code: string; message: string; retryAfter?: number };

export async function syncOnce(deps: SyncDeps, opts: SyncOptions = {}): Promise<SyncResult> {
  const { state } = deps;
  try {
    return await run(deps, opts);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'unauthorized') {
      // Revoked: keep base, id map and SyncID so signing in again resumes.
      await state.clearCredentials();
      await state.updateSync({ status: 'signed_out', lastError: e.message });
      return { status: 'signed_out' };
    }
    const code = e instanceof ApiError || e instanceof CryptoError || e instanceof VaultDocError ? e.code : 'internal';
    const message = e instanceof Error ? e.message : String(e);
    await state.updateSync({ status: 'error', lastError: message });
    return { status: 'error', code, message, ...(e instanceof ApiError && e.retryAfter !== undefined ? { retryAfter: e.retryAfter } : {}) };
  }
}

async function run(deps: SyncDeps, opts: SyncOptions): Promise<SyncResult> {
  const { api, adapter, state, now } = deps;
  let st = await state.getSync();
  const session = await state.getSession();
  const vaultKey = await state.getVaultKey();

  // 0. Preconditions.
  if (!session || !session.deviceToken || !vaultKey) return { status: 'signed_out' };
  if (st.paused && !opts.force) return { status: 'paused' };
  if (st.nextAttemptAt > now() && !opts.force) return { status: 'backoff', until: st.nextAttemptAt };

  // Roots: resolve (or verify pinned) native folders.
  const roots = await adapter.resolveRoots(opts.rejoin ? null : st.rootPins);
  if (roots.status === 'roots_changed') {
    await state.updateSync({ status: 'roots_changed' });
    return { status: 'roots_changed' };
  }
  if (roots.nativeSyncDetected && !st.nativeSyncAck) {
    await state.updateSync({ status: 'native_sync_detected', rootPins: roots.pins });
    return { status: 'native_sync_detected' };
  }
  let pins = roots.pins;
  if (opts.rejoin) st = await state.updateSync({ base: null, rootPins: pins, status: 'never' });

  const idMap = await state.loadIdMap();

  // 1. Crash recovery.
  if (st.pendingApply) {
    await rebindPending(await adapter.readTree(pins), st.pendingApply, idMap);
  }

  const base = st.base;
  let lastSeq = st.lastSeq;
  let skipped = new Set(st.skipped);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // 2. Project the browser.
    const events = deps.eventCount();
    const tree = await adapter.readTree(pins);
    let local = await project({ tree, idMap, base, skipped });

    // 3. Fetch the server's vault.
    const got = await api.getVault(base ? st.version : null);
    let remote: VaultDoc | null;
    let remoteVersion: number | null;
    if (got.status === 'not_modified') {
      remote = base!;
      remoteVersion = st.version;
    } else if (got.status === 'empty') {
      remote = null;
      remoteVersion = null;
    } else {
      remote = await decryptVault(got.body, vaultKey, session.username);
      remoteVersion = got.version;
    }

    // 4. Rollback check.
    const rolledBack = remote ? remote.seq < lastSeq : base !== null;
    if (rolledBack && opts.recovery === undefined) {
      await state.updateSync({ status: 'rollback_detected' });
      return { status: 'rollback_detected', remoteSeq: remote?.seq ?? null, lastSeq };
    }
    if (rolledBack && opts.recovery === 'accept_remote') lastSeq = remote?.seq ?? 0;

    // 5. Merge.
    let merged: VaultDoc;
    if (rolledBack && opts.recovery === 'use_local') {
      merged = local;
    } else if (!base) {
      const joined = firstSync(local, remote);
      if (joined.guidRemap.size > 0) {
        for (const [from, to] of joined.guidRemap) {
          const localId = idMap.localIdOf(from);
          const entry = localId === undefined ? undefined : idMap.entryOf(localId);
          if (entry) await idMap.set({ ...entry, guid: to });
        }
        local = await project({ tree, idMap, base, skipped });
      }
      merged = joined.doc;
    } else {
      merged = merge3(base, local, remote ?? emptyDoc()).doc;
    }

    // 6. Guard.
    const pending = guardCheck(local, remote ?? emptyDoc(), merged, remoteVersion);
    if (pending && !confirmationCovers(opts.confirmation, pending)) {
      await state.updateSync({ status: 'needs_confirmation', pendingConfirmation: pending });
      return { status: 'needs_confirmation', pending };
    }

    // 7. Apply to the browser.
    let writes = 0;
    if (!treesEqual(local, merged)) {
      if (deps.eventCount() !== events) continue; // the user edited meanwhile
      await state.updateSync({ pendingApply: merged });
      const ops = planOps(local, merged, (g) => idMap.localIdOf(g) !== undefined, skipped);
      try {
        const res = await applyOps(ops, { adapter, tree, idMap, pins, skipped });
        pins = res.pins;
        skipped = res.skipped;
        writes = res.writes;
      } catch (e) {
        if (e instanceof ConcurrentEditError) continue;
        throw e;
      }
    }
    skipped = pruneSkipped(skipped, merged);

    // 8. Upload.
    let version = remoteVersion;
    let uploaded = false;
    if (remote === null || !treesEqual(merged, remote) || (rolledBack && opts.recovery === 'use_local')) {
      const seq = Math.max(remote?.seq ?? 0, lastSeq) + 1;
      const doc: VaultDoc = { ...merged, seq, writtenBy: session.deviceId, writtenAt: now() };
      const put = await api.putVault(await encryptVault(doc, vaultKey, session.username), remoteVersion ?? 'none');
      if (put.status === 'conflict') {
        // Our browser now holds merged; the next attempt merges it with the newer vault.
        await state.updateSync({ rootPins: pins, skipped: [...skipped] });
        continue;
      }
      version = put.version;
      lastSeq = seq;
      merged = doc;
      uploaded = true;
    } else {
      lastSeq = Math.max(lastSeq, remote.seq);
    }

    // 9. Commit.
    await state.updateSync({
      base: merged,
      version,
      lastSeq,
      skipped: [...skipped],
      rootPins: pins,
      pendingApply: null,
      pendingConfirmation: null,
      status: 'ok',
      lastError: null,
      lastSyncAt: now(),
      nextAttemptAt: 0,
    });
    return { status: 'ok', uploaded, writes, version };
  }

  await state.updateSync({ status: 'conflict_exhausted', rootPins: pins, skipped: [...skipped] });
  return { status: 'conflict_exhausted' };
}
