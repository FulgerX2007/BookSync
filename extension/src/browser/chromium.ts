// Chromium family (Chrome, Edge, Brave, Vivaldi, Opera).
import { ROOT_MENU, ROOT_MOBILE, ROOT_OTHER, ROOT_TOOLBAR, type RootGuid } from '../model/vault';
import type { RootPins } from '../storage/state';
import { NativeAdapter, anchorPosition, type NativeNode, type RootResolution } from './adapter';

/** Chromium has no menu root; Firefox's Bookmarks Menu lives in this folder under Other bookmarks. */
export const MENU_FOLDER_TITLE = 'Bookmarks Menu';

const FOLDER_TYPE: Record<string, string> = {
  [ROOT_TOOLBAR]: 'bookmarks-bar',
  [ROOT_OTHER]: 'other',
  [ROOT_MOBILE]: 'mobile',
};
const LEGACY_ID: Record<string, string> = { [ROOT_TOOLBAR]: '1', [ROOT_OTHER]: '2', [ROOT_MOBILE]: '3' };
const PERMANENT: readonly RootGuid[] = [ROOT_TOOLBAR, ROOT_OTHER, ROOT_MOBILE];

export class ChromiumAdapter extends NativeAdapter {
  readonly flavor = 'chromium' as const;

  async resolveRoots(pins: RootPins | null): Promise<RootResolution> {
    const [top] = await this.api.getTree();
    const tops = top?.children ?? [];
    const chosen = new Map<RootGuid, NativeNode>();
    for (const root of PERMANENT) {
      let node: NativeNode | undefined;
      if (pins) {
        node = tops.find((t) => t.id === pins[root]);
      } else {
        // Chromium 134+ may expose a local and a Google-account folder per
        // type; prefer the local one. Older versions have fixed ids 1/2/3.
        const candidates = tops.filter((t) => t.folderType === FOLDER_TYPE[root]);
        node = candidates.find((t) => t.syncing !== true) ?? candidates[0] ?? tops.find((t) => t.id === LEGACY_ID[root] && t.folderType === undefined);
      }
      if (node) chosen.set(root, node);
    }
    const missing = PERMANENT.filter((r) => !chosen.has(r));
    if (missing.length > 0) return { status: 'roots_changed', missing };

    const next: RootPins = {};
    for (const [root, node] of chosen) next[root] = node.id;
    const other = chosen.get(ROOT_OTHER)!;
    const pinnedMenu = pins?.[ROOT_MENU];
    const menu = pinnedMenu !== undefined && other.children?.some((c) => c.id === pinnedMenu) ? pinnedMenu : findMenuFolder(other.children ?? []);
    if (menu !== undefined) next[ROOT_MENU] = menu;

    return { status: 'ok', pins: next, nativeSyncDetected: [...chosen.values()].some((n) => n.syncing === true) };
  }

  protected override excludedFromRoot(root: RootGuid, pins: RootPins): ReadonlySet<string> {
    const menu = pins[ROOT_MENU];
    return root === ROOT_OTHER && menu !== undefined ? new Set([menu]) : new Set();
  }

  async ensureRoot(root: RootGuid, pins: RootPins): Promise<{ id: string; pins: RootPins }> {
    if (root !== ROOT_MENU) {
      const id = pins[root];
      if (id === undefined) throw new Error(`root ${root} is not pinned`);
      return { id, pins };
    }
    const otherId = pins[ROOT_OTHER];
    if (otherId === undefined) throw new Error('Other bookmarks is not pinned');
    const kids = await this.api.getChildren(otherId);
    const pinned = pins[ROOT_MENU];
    if (pinned !== undefined && kids.some((c) => c.id === pinned)) return { id: pinned, pins };
    const id = findMenuFolder(kids) ?? (await this.api.create({ parentId: otherId, title: MENU_FOLDER_TITLE })).id;
    return { id, pins: { ...pins, [ROOT_MENU]: id } };
  }

  /** Chromium inserts before the node currently at `index`, counted before the moved node is removed. */
  protected indexAfter(children: NativeNode[], afterId: string | null): number {
    return anchorPosition(children, afterId) + 1;
  }

  override importEvents() {
    const { onImportBegan, onImportEnded } = this.api;
    return onImportBegan && onImportEnded ? { began: onImportBegan, ended: onImportEnded } : null;
  }
}

function findMenuFolder(children: NativeNode[]): string | undefined {
  return children.find((c) => c.url === undefined && c.title === MENU_FOLDER_TITLE && c.unmodifiable === undefined)?.id;
}
