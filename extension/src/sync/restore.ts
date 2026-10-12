// Restoring an old vault version: its content is uploaded as a new version
// (history is append-only), with a seq above every device's so nobody sees a
// rollback. Then this browser follows through a normal, guarded sync.
import type { ApiClient } from '../api/client';
import { decryptVault, encryptVault } from '../crypto/vault-cipher';
import type { StateStore } from '../storage/state';
import { RequestError } from '../background/router';
import type { SyncOptions, SyncResult } from './engine';

export interface RestoreDeps {
  api: ApiClient;
  state: StateStore;
  now: () => number;
  sync: (opts: SyncOptions) => Promise<SyncResult | undefined>;
}

export async function restoreVersion(deps: RestoreDeps, version: number): Promise<SyncResult | undefined> {
  const { api, state } = deps;
  const session = await state.getSession();
  const key = await state.getVaultKey();
  if (!session?.deviceToken || !key) throw new RequestError('not_signed_in', 'this browser is not signed in');

  const old = await decryptVault(await api.getVersion(version), key, session.username);
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await api.getVault(null);
    if (cur.status !== 'ok') throw new RequestError('not_found', 'the server has no current vault');
    const current = await decryptVault(cur.body, key, session.username);
    const seq = Math.max(current.seq, (await state.getSync()).lastSeq) + 1;
    const doc = { ...old, seq, writtenBy: session.deviceId, writtenAt: deps.now() };
    const put = await api.putVault(await encryptVault(doc, key, session.username), cur.version);
    if (put.status === 'conflict') continue; // someone wrote meanwhile: recompute against the newer vault
    // The user chose this version: its deletions are confirmed for exactly this server state.
    return deps.sync({ force: true, confirmation: { remoteVersion: put.version, deletionsToLocal: Infinity, deletionsToRemote: Infinity } });
  }
  throw new RequestError('conflict', 'the vault kept changing; try again');
}
