// Firefox: roots have fixed GUID ids that equal our canonical root guids.
import { type RootGuid } from '../model/vault';
import type { RootPins } from '../storage/state';
import { BookmarkRejectedError, NativeAdapter, SYNCED_ROOTS, anchorPosition, type NativeNode, type RootResolution } from './adapter';

export class FirefoxAdapter extends NativeAdapter {
  readonly flavor = 'firefox' as const;

  async resolveRoots(): Promise<RootResolution> {
    const [top] = await this.api.getTree();
    const present = new Set((top?.children ?? []).map((c) => c.id));
    // A root this Firefox lacks is simply not synced here (projection carries it from base).
    const pins: RootPins = {};
    for (const root of SYNCED_ROOTS) if (present.has(root)) pins[root] = root;
    return { status: 'ok', pins, nativeSyncDetected: false };
  }

  async ensureRoot(root: RootGuid, pins: RootPins): Promise<{ id: string; pins: RootPins }> {
    const id = pins[root];
    if (id === undefined) throw new BookmarkRejectedError(`this Firefox has no ${root} root`);
    return { id, pins };
  }

  /** Firefox's index is the node's final position (Places shifts the nodes in between). */
  protected indexAfter(children: NativeNode[], afterId: string | null, movingId?: string): number {
    const p = anchorPosition(children, afterId);
    const i = movingId === undefined ? -1 : children.findIndex((c) => c.id === movingId);
    return i >= 0 && i <= p ? p : p + 1;
  }
}
