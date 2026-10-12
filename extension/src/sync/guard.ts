// Mass-deletion guard: a sync that would delete a large share of bookmarks in
// either direction waits for the user. A confirmation only covers the exact
// situation the user was shown (same server version, no more deletions).
import { countNodes, type VaultDoc } from '../model/vault';
import type { PendingConfirmation } from '../storage/state';
import { diffStats } from './merge';

export const GUARD_MIN_DELETIONS = 20;
export const GUARD_FRACTION = 0.25;

function excessive(deletions: number, total: number): boolean {
  return deletions >= GUARD_MIN_DELETIONS && deletions > total * GUARD_FRACTION;
}

/**
 * Returns the summary to confirm, or null when the sync may proceed.
 * remoteVersion identifies the server state the merge was made against.
 */
export function guardCheck(local: VaultDoc, remote: VaultDoc, merged: VaultDoc, remoteVersion: number | null): PendingConfirmation | null {
  const deletionsToLocal = diffStats(local, merged).deletes;
  const deletionsToRemote = diffStats(remote, merged).deletes;
  if (!excessive(deletionsToLocal, countNodes(local)) && !excessive(deletionsToRemote, countNodes(remote))) return null;
  return { remoteVersion, deletionsToLocal, deletionsToRemote };
}

/** A confirmation is valid only for the same server version and at most the confirmed deletions. */
export function confirmationCovers(confirmed: PendingConfirmation | undefined, pending: PendingConfirmation): boolean {
  return (
    confirmed !== undefined &&
    confirmed.remoteVersion === pending.remoteVersion &&
    pending.deletionsToLocal <= confirmed.deletionsToLocal &&
    pending.deletionsToRemote <= confirmed.deletionsToRemote
  );
}
