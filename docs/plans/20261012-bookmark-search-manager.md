# BookSync: bookmark search and manager

## Overview
- **What this adds:** search and bookmark management inside the BookSync extension, on Chromium and Firefox alike:
  - **Popup search.** Type any part of a bookmark's title or URL in the toolbar popup and open the result.
  - **Bookmark this page.** The popup adds the current tab to a folder you pick.
  - **Manager page.** A full-tab tree where you can:
    - create, rename, edit and delete bookmarks and folders;
    - move them with drag and drop;
    - select several items and move or delete them together.
- **Problem.**
  - The browsers' own search is word-based in Chrome and behaves differently in Firefox, so "part of a name" doesn't work reliably.
  - Organizing bookmarks means a different native manager in every browser.
- **Integration.**
  - The UI reads and edits the browser's own bookmarks through the existing `src/browser` adapter.
  - Sync already reacts to every native bookmark change, so every edit reaches the other browsers through the normal debounced sync.
  - Nothing changes in sync, the server, the crypto or `docs/protocol.md`.

### Acceptance criteria
1. **Popup search.**
   - Typing in the popup lists bookmarks whose title or URL contains the text. Matching ignores case and accents, and several words must all match.
   - Each result shows its folder path.
   - Up/Down select a result; Enter or a click opens it in a new tab.
2. **Manager.** "Manage bookmarks" in the popup opens the manager. It shows the synced root folders as a tree and supports:
   - new bookmark and new folder;
   - rename and edit URL;
   - delete, with a confirmation that names the counts for folders or several items.
   - Its search box finds bookmarks and folders and reveals the chosen one in the tree.
3. **Drag and drop.**
   - Reorders inside a folder and moves into another folder (a collapsed folder or a root included), with a visible drop indicator.
   - Impossible drops are refused: into itself or its own descendant, beside a root, or dragging a root.
   - Roots can't be renamed, moved or deleted.
4. **Multi-select.**
   - Ctrl/Cmd-click toggles and Shift-click selects a range.
   - Dragging or deleting acts on the whole selection, keeping the items' relative order.
5. **Bookmark this page.** The popup button adds the current tab to a chosen folder and shows where the page is already bookmarked, if anywhere.
6. **Sync and live updates.**
   - Changes made in the manager reach the other signed-in browsers through normal sync.
   - The manager refreshes live when sync, or the browser's own UI, changes bookmarks, without losing an edit in progress.
   - It works signed out too: it is just the browser's bookmarks.
7. **Both browsers.**
   - Same behavior on Chromium and Firefox.
   - Firefox separators stay put.
   - URLs the browser refuses (e.g. `javascript:` or `file:` in Firefox) produce a readable error.

### Non-goals
- Undo.
- Keyboard navigation of the manager tree. The popup's result list does get Up/Down/Enter/Escape.
- Hover-to-expand while dragging (dropping onto a collapsed folder already works).
- Match highlighting, favicons, tags, keywords and separators.
- Sorting or de-duplication tools, and import/export.
- A browser side panel.
- Editing nodes this browser cannot hold (`skipped`).

## Context (from discovery)
- **Extension UI.**
  - Two plain-TypeScript pages, `src/ui/popup` (104 lines) and `src/ui/options` (518 lines), built with `h()`/`replace()` from `src/ui/shared/dom.ts`. There is no framework and no runtime dependencies.
  - `build.mjs` bundles `entryPoints` (background, popup, options) and copies every html/css under `src/ui` flat into `dist/<target>`.
  - ⚠️ The popup's `render()` rebuilds all of `#app` on every status publish (`popup.ts:85`, `onStatus` at `:98`). The scheduler publishes twice per run (`scheduler.ts:147, 161`), and that includes the 1-minute poll. New popup UI must live outside that container.
- **Browser layer (`src/browser/adapter.ts`).** `NativeAdapter`, with `ChromiumAdapter` and `FirefoxAdapter`, provides:
  - `resolveRoots(pins)`, which is read-only (only `getTree`) and returns `{ status: 'ok', pins, … } | { status: 'roots_changed', missing }`.
  - `readTree(pins)`, which returns a `LocalTree`:
    - roots by canonical guid;
    - separators and managed folders hidden;
    - the Chromium "Bookmarks Menu" folder mapped to the menu root.
  - Anchor-based `create(parent, afterId)` and `moveAfter(id, parent, afterId)`, which absorb Chromium's and Firefox's different `move` index semantics. A vanished anchor currently throws a plain `Error` (`anchorPosition`, `adapter.ts:232-236`).
  - `update`, `remove` (which raises `NonEmptyFolderError` on a non-empty folder), `subtreeIds` (children before parents), `changeEvents()`, and `BookmarkRejectedError`.
- **Sync.**
  - The background `SyncScheduler` listens to bookmark events: a 3 s debounce, then sync. Runs are single-flight.
  - The mass-deletion guard asks the user when a sync would delete more than 25 % of the bookmarks and at least 20. It counts folders as "bookmark(s)" (`guard.ts`).
  - Pins are committed only at the end of a sync run (`engine.ts:204-209`), and pins can change while a page is open.
- **Messages.**
  - `src/background/messages.ts` holds the `Protocol` map, and `router.ts` dispatches it.
  - Handlers are registered through testable modules (`registerSyncHandlers` in `scheduler.ts`, `registerAccountHandlers` in `account.ts`). `index.ts` has import-time side effects.
- **Tests.**
  - vitest runs in Node (`environment: 'node'`) and excludes `src/ui/**` from coverage. All logic must therefore live outside `src/ui`, in a new `src/bookmarks/`.
  - `test/fakes/bookmarks.ts` is a high-fidelity Chromium/Firefox fake. It refuses privileged URLs on Firefox, including `file:`.
  - Playwright e2e drives real Chromium with the unpacked e2e build, which pre-grants `http://127.0.0.1/*` (`e2e/fixtures.ts`: `ExtBrowser.bookmarks()`, `openPopup()`, `openOptions()`).
- **Manifest.**
  - Permissions today: `bookmarks`, `storage`, `alarms`.
  - "Bookmark this page" needs `activeTab`, which shows no install warning.
  - `tabs.create` needs no permission.

## Development Approach
- **testing approach**: Regular (code first, then tests, in the same task)
- complete each task fully before moving to the next
- make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
  - tests are not optional - they are a required part of the checklist
  - write unit tests for new functions/methods
  - write unit tests for modified functions/methods
  - add new test cases for new code paths
  - update existing test cases if behavior changes
  - tests cover both success and error scenarios
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- run tests after each change (`npm run check` in `extension/`; `make e2e` for UI tasks)
- maintain backward compatibility: the existing popup status, buttons and element ids (`#popup-status`, `#sync-now`, …) stay as they are

## Testing Strategy
- **Unit tests (vitest, Node).**
  - Every pure module in `src/bookmarks/` is unit-tested: tree helpers, search, drop rules, selection, edit operations and the refresh gate. So is the background handler in `src/background/bookmarks.ts`.
  - Edit operations and the handler run against `test/fakes/bookmarks.ts` in **both** flavors. Firefox is mostly verified this way, including separators, privileged-URL refusal and its move semantics.
  - Target ≥ 90 % statements for `src/bookmarks`, like `src/sync` and `src/browser`.
- **E2E tests (Playwright, real Chromium).**
  - Every UI task adds e2e tests in the same task (`e2e/popup-search.spec.ts`, `e2e/manager.spec.ts`).
  - Drag and drop uses `locator.dragTo(target, { targetPosition })`, which drives HTML5 drag-and-drop in Chromium.
  - Bookmarks are seeded and verified through `ExtBrowser.bookmarks()`.
- **DOM code stays thin.** `src/ui/**` only renders and wires events; every decision (what matches, what a click selects, where a drop lands, when to refresh) is a pure function in `src/bookmarks/`.
- **Not covered by e2e:**
  - Firefox: drag and drop and `activeTab`.
  - The real toolbar popup: the e2e tests open `popup.html` as a tab.

  These are listed under Post-Completion manual verification.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope
- keep plan in sync with actual work done

## Solution Overview
```
 popup.html                                        manager.html (full tab)
  #search (search, this page)                       list tree · drag & drop · edit · multi-select
  #status-app (status, unchanged)                   search → reveal in tree
        │                                                   │
        └──────────► src/bookmarks/ (pure, unit-tested) ◄───┘
                      tree.ts       helpers over LocalTree
                      search.ts     substring search
                      selection.ts  click / ctrl / shift
                      drop.ts       where a drop lands
                      refresh.ts    refresh gate (defer while editing)
                      ops.ts        create / rename / move / delete ──► BookmarksAdapter ──► browser bookmarks
                                                                                    │ events
   background: bookmarkRoots handler (src/background/bookmarks.ts)                   ▼
               SyncScheduler (unchanged) ─────────────────────────────────► sync to other browsers
```
- **Single source of truth.** The UI reads and edits the browser's own bookmarks. Sync stays the only component that talks to the vault and doesn't know the manager exists.
- **The same roots as sync.**
  - On every load, the UI asks the background for the roots (`bookmarkRoots`). The background returns `adapter.resolveRoots(storedPins)`, which checks the pinned ids and still finds a menu folder that isn't pinned yet.
  - The UI then builds its own adapter over `ext().bookmarks`, flavored by `__BOOKSYNC_TARGET__`.
  - The manager therefore shows the synced folders under the same canonical roots on both browsers, and the Chromium menu folder never shows up as an ordinary folder inside Other bookmarks.
- **Every write goes through `ops.ts` and the adapter.**
  - Positions are anchor-based, so drag and drop gets Chromium's and Firefox's index semantics right, and separators stay put.
  - `ops.ts` refuses roots. That includes the Chromium menu folder, which is a plain native folder that renaming would break.
- **Deleting a folder** removes `[...subtreeIds(id), id]` bottom-up with `remove`, never `removeTree`, following the project invariant.
- **Search runs in the extension.** A normalized index is built once per tree load. This gives true substring matching that behaves the same in every browser.
- **Live refresh without losing edits.** The manager subscribes to bookmark events through a refresh gate:
  - While an inline edit, a dialog, a drag or the manager's own multi-step operation is active, events only mark the tree dirty.
  - Otherwise, a re-read happens 150 ms after the last event.
  - Expanded folders, the selection and the scroll position survive the re-read.
- **The popup is split into two containers.** Status re-renders touch only `#status-app`, so the search box and the "Bookmark this page" form survive the twice-a-minute status publishes.

## Technical Details

**Tree helpers (`src/bookmarks/tree.ts`, directly over `LocalTree`, no copy)**
```ts
rootIds(t: LocalTree): string[]                    // present roots in SYNCED_ROOTS order
isRootId(t, id): boolean
pathOf(t, id): string[]                            // ancestor folder titles, root first
isAncestor(t, a, b): boolean                       // a is b or an ancestor of b
treeOrder(t): string[]                             // all ids, depth-first
visibleOrder(t, expanded: Set<string>): string[]   // rows top to bottom
normalizeSelection(t, ids): string[]               // drop roots, drop ids under a selected ancestor, sort in tree order
folderOptions(t): { id: string; label: string; depth: number }[]  // indented folder list for <select>
countSubtree(t, ids): { bookmarks: number; folders: number }    // for confirmations
```

**Search (`src/bookmarks/search.ts`)**
- **Normalization.**
  - Every string becomes `s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()`.
  - URLs are first passed through `decodeURI`, inside a try/catch, so that percent-encoded accents match.
- **Matching.**
  - The query is split on whitespace; every token must occur in the title or in the URL. Each token may match either field.
  - Folders match on the title only.
  - `kinds` filters the results: the popup asks for bookmarks only, the manager for both.
- **Ranking.**
  1. Nodes where every token matches the title.
  2. Every other match.

  Each group is in tree order.
- **Results** have the shape `{ id, kind, title, url?, path, allInTitle }`, without highlight ranges.
  - `limit` is 50 in the popup and unlimited in the manager.
  - An empty query returns no results.
- **Index.** `createSearchIndex(tree)` precomputes the normalized strings once.

**Selection (`src/bookmarks/selection.ts`)**
- `select(state, id, { ctrl, shift }, visibleOrder)` returns a new `{ selected: Set, anchor }`:
  - a plain click selects one item;
  - Ctrl/Cmd toggles one item;
  - Shift selects the range from the anchor in visible order.
- Roots can be selected, so that new items can be created inside them. `normalizeSelection` drops them from drag and delete; if nothing remains, the action is refused.

**Drop rules (`src/bookmarks/drop.ts`)**
- **Zones.** `zoneAt(offsetY, height, isFolder)` returns:
  - `before` for the top 25 %;
  - `after` for the bottom 25 %;
  - `inside` for the middle of a folder;
  - for a bookmark, `before` or `after` by halves.
- **Resolution.** `resolveDrop(tree, dragged, targetId, zone, expanded)` returns `{ parentId, afterId }`, `{ noop: true }` or `{ refused: reason }`. Rules, in order of precedence:
  1. **Refused drags.** A root can't be dragged, and nothing is dropped onto or into a dragged node or its descendants.
  2. **`after` an expanded folder that has children** means "first child". This also covers an expanded root, the default, so dropping at the bottom edge of a root row lands at its top.
  3. **Beside a root.** Any other `before` or `after` next to a root is refused.
  4. **`inside`** appends at the end of the folder.
  5. **`before X`** anchors after X's previous sibling that is not being dragged, or "first" if there is none. `after X` anchors after X, or after X's previous non-dragged sibling if X itself is being dragged.
  6. **No-op.** A drop that leaves every dragged node where it is returns `noop`, and nothing is written.
- **Firefox separators.** Anchors express only "after P". On Firefox, "before X" with a separator between P and X therefore lands directly after P, before the separator. Tests pin this behavior down; they don't claim exact visual placement.

**Operations (`src/bookmarks/ops.ts`, over `BookmarksAdapter`)**
- **Creating.**
  - `createBookmark(adapter, parentId, afterId | 'end', { title, url })` and `createFolder(adapter, parentId, afterId | 'end', title)`.
  - `'end'` resolves to the folder's last child.
- **Editing.**
  - `rename(adapter, tree, id, title)` and `setUrl(adapter, tree, id, url)`.
  - The URL must parse as an absolute URL.
  - `BookmarkRejectedError` becomes a readable message.
- **`moveMany(adapter, tree, ids, parentId, afterId)`** normalizes the selection, then calls `moveAfter` for each id in turn, each one anchored after the previously moved id.
- **`deleteMany(adapter, tree, ids)`** normalizes the selection, then for each top-level id removes `[...await adapter.subtreeIds(id), id]` in order.
  - If anything fails part-way, it stops: the remaining top-level items are left untouched, and it throws `StaleTreeError`.
  - Descendants captured before a child was added late are already gone. The late child and its folder survive.
- **Roots.** Every function throws `RootLockedError` when given a root id, including the Chromium menu folder.
- **Stale tree.** These all become `StaleTreeError` ("Bookmarks changed meanwhile; please try again"), and the UI refreshes:
  - `AnchorMissingError` (new, typed, in `adapter.ts`);
  - `NonEmptyFolderError`;
  - browser "not found" errors (`/not found|can't find/i`): a vanished parent, a vanished moved node, or a node already gone at `remove`.

**Refresh gate (`src/bookmarks/refresh.ts`)**
- `createRefreshGate({ refresh, debounceMs = 150, timers })` returns `{ notify(), hold(): release }`.
- `notify()` (re)arms the debounce. While any hold is active, it only marks the tree dirty.
- Releasing the last hold refreshes once if the tree is dirty.
- The manager holds the gate during inline rename, the edit dialog, a drag, and every operation it starts. After an operation it always refreshes once, at the end.

**Messages and pages**
- **`Protocol.bookmarkRoots`** (`{} → RootPins`). Registered by `registerBookmarkHandlers(router, { adapter, state })` in `src/background/bookmarks.ts`.
  - It returns the `pins` from `adapter.resolveRoots((await state.getSync()).rootPins)`.
  - `roots_changed` becomes `RequestError('roots_changed', …)`, which the UI shows with a pointer to settings.
- **`src/ui/shared/bookmarks.ts`** exposes `openBookmarks()`, which returns:
  - `adapter`;
  - `load()`, which re-fetches pins **on every call** and then `readTree`s;
  - `onChange(cb)`, which listens to the adapter's `changeEvents()` and is driven through the refresh gate by the page.
- **`manager.html`** is a new entry point (`src/ui/manager/manager.ts`).
  - The popup opens it with `tabs.create({ url: runtime.getURL('manager.html') })`.
  - `manager.html?reveal=<id>` reveals a node on open.
- **Bookmark this page.**
  - The popup reads the current tab with `tabs.query({ active: true, currentWindow: true })`. This works under `activeTab` once the toolbar popup is open.
  - In e2e builds only, `popup.html?tab=<id>` names the tab instead. The e2e test therefore exercises the override path, not `activeTab`.
  - The button is enabled whenever the tab has a URL. If the browser refuses it (Firefox: `file:`, `about:`), the `BookmarkRejectedError` message is shown.
  - "Already bookmarked in …" uses `matchKey` from `src/model/url.ts`.

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): tasks achievable within this codebase - code changes, tests, documentation updates
- **Post-Completion** (no checkboxes): items requiring external action - manual testing, changes in consuming projects, deployment configs, third-party verifications

## Implementation Steps

### Task 1: Tree helpers over LocalTree
**Files:**
- Create: `extension/src/bookmarks/tree.ts`
- Create: `extension/src/bookmarks/tree.test.ts`

- [x] implement `rootIds`, `isRootId`, `pathOf`, `isAncestor`, `treeOrder` and `visibleOrder` directly over `LocalTree`
- [x] implement `normalizeSelection`, `folderOptions` and `countSubtree`
- [x] write tests, building trees through the adapter's `readTree` over `test/fakes/bookmarks.ts`:
  - root order with absent roots (Chromium without the menu folder, hidden empty Mobile);
  - the menu folder as a root;
  - paths, ancestry, and visible order with collapsed and expanded folders;
  - `normalizeSelection` drops roots and descendants of selected folders, and sorts in tree order.
- [x] write tests for edge cases: empty folders, deep nesting, unknown ids, the folder option labels (indentation, root names)
- [x] run `npm run check` - must pass before task 2
- [x] ➕ `extension/test/bookmark-trees.ts`: a fake browser plus the real adapter (`browser(flavor)`, `idOf`, `childTitles`), shared by the `src/bookmarks` tests

### Task 2: Substring search
**Files:**
- Create: `extension/src/bookmarks/search.ts`
- Create: `extension/src/bookmarks/search.test.ts`

- [x] implement `normalize`, `createSearchIndex(tree)` and `search(index, query, { limit, kinds })` per Technical Details (token AND, title or URL, two ranking groups, folder path)
- [x] write tests for matching:
  - part of a title, and part of a URL (`example.org/do`);
  - case and accents (`cafe` finds `Café`);
  - a percent-encoded URL found by an accented query;
  - a ligature (`ﬁ`);
  - several words, including one token in the title and another in the URL (falls into group 2).
- [x] write tests for results: folders match by title only, `kinds` filtering, ranking, `limit`, and empty or whitespace-only queries
- [x] write a performance test: 10k bookmarks, warm up first, assert the median of 5 queries is under 50 ms (the 10 ms target is checked manually)
- [x] run `npm run check` - must pass before task 3

### Task 3: Edit operations over the adapter
**Files:**
- Modify: `extension/src/browser/adapter.ts`
- Modify: `extension/src/browser/chromium.test.ts` / `extension/src/browser/firefox.test.ts`
- Create: `extension/src/bookmarks/ops.ts`
- Create: `extension/src/bookmarks/ops.test.ts`

- [x] add a typed `AnchorMissingError` to `adapter.ts`, thrown by `anchorPosition`. Keep the message text, and check that nothing in `src/sync` or `src/browser` matches on it.
- [x] implement `createBookmark`, `createFolder` (`'end'` placement), `rename` and `setUrl` (absolute-URL validation, `BookmarkRejectedError` → readable message). All four refuse root ids with `RootLockedError`.
- [x] implement `moveMany` (anchor chain keeps relative order) and `deleteMany` (`[...subtreeIds(id), id]` bottom-up, never `removeTree`, stop at the first failure). Map stale-tree failures to `StaleTreeError`.
- [x] write tests against `test/fakes/bookmarks.ts` in **both** flavors:
  - moves down and up within a folder (Chromium pre-removal index vs Firefox final index);
  - moves into another folder, and to the first position;
  - a multi-move keeps relative order and skips descendants of selected folders;
  - a multi-move whose anchor is one of the dragged nodes.
- [x] write the Firefox and Chromium specifics as tests:
  - a Firefox separator stays put, and "before X" across a separator lands after P;
  - the Chromium menu folder works as a target and can't be renamed, moved or deleted.
- [x] write tests for error cases:
  - a privileged or `file:` URL refused on Firefox, and an invalid URL;
  - a vanished anchor, a vanished parent, and a vanished moved node all give `StaleTreeError`;
  - a folder that gains a child during `deleteMany`: the captured descendants are gone, the folder and the late child survive, the later top-level items are untouched, and the error is `StaleTreeError`;
  - a root id given to every operation.
- [x] run `npm run check` - must pass before task 4
- [x] ➕ `ops.ts` also exports `InvalidUrlError` (unparseable or browser-refused URL) and `parseUrl`. "Not found" errors from the browser (`/not found|can't find|no bookmarks? found/i`, which covers Chromium's and Firefox's wording) become `StaleTreeError`. Asking for a folder's URL, or using a bookmark as a parent, is a plain error, not a stale tree.

### Task 4: Selection and drop rules
**Files:**
- Create: `extension/src/bookmarks/selection.ts`
- Create: `extension/src/bookmarks/selection.test.ts`
- Create: `extension/src/bookmarks/drop.ts`
- Create: `extension/src/bookmarks/drop.test.ts`

- [x] implement `select` (plain, Ctrl/Cmd toggle, Shift range from the anchor in visible order)
- [x] implement `zoneAt` and `resolveDrop` with the precedence listed in Technical Details
- [x] write tests for `select`: single, toggle on and off, Shift ranges up and down, Shift after a toggle, ranges across folder boundaries and over roots
- [x] write table-driven tests for `resolveDrop`:
  - before, after and inside;
  - into a collapsed folder, and onto a root (inside);
  - after an expanded root, which gives the first child;
  - before or after a node that is itself being dragged;
  - refusals: a root dragged, beside a root, into self, into its own descendant;
  - no-op drops.
- [x] write tests for `zoneAt` boundaries (25 % and 75 %, bookmark halves)
- [x] run `npm run check` - must pass before task 5
- [x] ➕ `selection.ts` also exports `pruneSelection`, which drops ids a refresh removed, for live refresh. In `resolveDrop`, "after" an expanded root counts as "first child" even when the root is empty; otherwise an empty root such as Firefox's Mobile Bookmarks couldn't be dropped into from its bottom edge.

### Task 5: Roots handler, refresh gate and UI bookmark access
**Files:**
- Create: `extension/src/background/bookmarks.ts`
- Create: `extension/src/background/bookmarks.test.ts`
- Modify: `extension/src/background/messages.ts`
- Modify: `extension/src/background/index.ts`
- Create: `extension/src/bookmarks/refresh.ts`
- Create: `extension/src/bookmarks/refresh.test.ts`
- Create: `extension/src/ui/shared/bookmarks.ts`

- [x] add `bookmarkRoots` to `Protocol`. Implement `registerBookmarkHandlers(router, { adapter, state })` per Technical Details, and call it from `index.ts`.
- [x] implement `createRefreshGate` with injectable timers. Implement `openBookmarks()` in `src/ui/shared/bookmarks.ts`: `load()` re-fetches pins every call, and `onChange` uses the adapter's `changeEvents()`.
- [x] write handler tests over `FakeBookmarks` in both flavors:
  - stored pins are returned;
  - a menu folder that isn't pinned yet shows up as the menu root;
  - it works signed out;
  - `roots_changed` gives a `RequestError`;
  - the handler never writes sync state.
- [x] write refresh-gate tests:
  - a debounce coalesces bursts;
  - a hold defers, and releasing it refreshes once only if the tree is dirty;
  - nested holds;
  - no refresh after release when nothing changed.
- [x] run `npm run check` - must pass before task 6
- [x] ➕ The refresh gate also serializes refreshes, so an older read can never overwrite a newer one. `release(true)` forces one refresh, for an operation that failed without firing any event. `openBookmarks()` itself is thin glue, so the e2e tests in Tasks 6 and 8 cover it.

### Task 6: Popup search
**Files:**
- Modify: `extension/src/ui/popup/popup.html`
- Modify: `extension/src/ui/popup/popup.ts`
- Modify: `extension/src/ui/popup/popup.css`
- Create: `extension/e2e/popup-search.spec.ts`

- [x] split the popup into `#search`, built once, and `#status-app`. `render()` only touches `#status-app` and keeps the existing ids, so `e2e/popup.spec.ts` still passes unchanged.
- [x] add a search box (focused on open) and a results list of bookmarks only. Each result shows the title, the muted URL host and the folder path; long titles end in an ellipsis, with the full text in a tooltip.
- [x] Up/Down move the selection, and Enter or a click opens the bookmark in a new tab (`tabs.create`) and closes the popup. Escape clears the box. A refused URL (e.g. `javascript:`) shows its error inline.
- [x] search works signed out (it doesn't depend on `getStatus`); the index is rebuilt when `onChange` fires
- [x] write e2e tests:
  - seed bookmarks, then search by part of a title, part of a URL, mixed case and accents, and two words;
  - Up/Down then Enter opens the expected URL in a new page;
  - the no-results message.
- [x] write an e2e test that the query and results survive a status re-render (type, then click `#sync-now`)
- [x] run `npm run check` and `make e2e` - must pass before task 7
- [x] ➕ The search lives in `src/ui/popup/search.ts` (`mountSearch`), and the status container is now `#status-app`. After opening a tab the popup closes itself, and the e2e test asserts that. A refused URL (`javascript:`) gets its own e2e test. The suite was stable across `--repeat-each=2`.

### Task 7: Bookmark this page
**Files:**
- Modify: `extension/manifests/base.json`
- Modify: `extension/scripts/manifest.test.ts`
- Modify: `extension/src/ui/popup/popup.ts`
- Modify: `extension/e2e/fixtures.ts`
- Modify: `extension/e2e/popup-search.spec.ts`
- Modify: `extension/src/model/url.ts` (comment: `matchKey` also finds existing bookmarks)

- [x] add the `activeTab` permission, and update the manifest test's expected permissions
- [x] add the "Bookmark this page" button and form inside `#search`:
  - the title is prefilled;
  - a folder `<select>` built from `folderOptions`, defaulting to Other Bookmarks;
  - the form holds its state across status re-renders.
- [x] read the tab with `tabs.query({ active: true, currentWindow: true })`, accepting `?tab=<id>` in e2e builds only. Show "Already bookmarked in …" via `matchKey`. Save with `createBookmark(…, 'end', …)`; show refusals inline.
- [x] add `ExtBrowser.tabIdOf(url)` to the e2e fixtures (runs `chrome.tabs.query` in the worker)
- [x] write e2e tests:
  - bookmark a page served by the test server into a nested folder, and check it via `chrome.bookmarks`;
  - the "already bookmarked" hint on reopening.

  These cover the override path; `activeTab` is checked manually.
- [x] write unit tests for the refusal path: the Firefox fake refuses a `file:` page through `createBookmark` and the message is readable (in `ops.test.ts`)
- [x] run `npm run check` and `make e2e` - must pass before task 8
- [x] ➕ The form lives in `src/ui/popup/this-page.ts` (`mountThisPage`) and its own `#this-page` section. The unit test for the refusal path already existed in `ops.test.ts` (Task 3).
- [x] ⚠️ Running the full e2e suite exposed an existing race in the test harness:
  - **Symptom:** the first `bookmarks()` call failed about 1 time in 20 with "reading 'create'" on undefined.
  - **Cause:** Playwright reports the service worker before Chromium installs its extension APIs. Four launches in parallel reproduced it 6 times in 60.
  - **Fix:** `e2e/fixtures.ts` now waits for `chrome.bookmarks`. After that, the sync spec passed 24/24 with `--repeat-each=4`, and the full suite 38/38.

### Task 8: Manager page shell, live tree and selection
**Files:**
- Create: `extension/src/ui/manager/manager.html`
- Create: `extension/src/ui/manager/manager.ts`
- Create: `extension/src/ui/manager/manager.css`
- Modify: `extension/build.mjs`
- Modify: `extension/src/ui/popup/popup.ts`
- Modify: `extension/e2e/fixtures.ts`
- Create: `extension/e2e/manager.spec.ts`

- [x] add the `manager` entry point to `build.mjs` (html/css are already copied by the existing glob), and the popup's "Manage bookmarks" button
- [x] render the tree as nested lists: expand toggles are buttons with `aria-expanded`, and the full ARIA tree keyboard pattern is a non-goal.
  - roots are expanded on open;
  - folders show item counts;
  - URLs are muted, and long titles and URLs end in an ellipsis with a tooltip;
  - double-click on a bookmark opens it;
  - roots show no rename or delete actions.
- [x] wire plain-click selection through `select()` (on click, not mousedown)
- [x] wire live refresh through the refresh gate: it keeps expanded folders, the selection and the scroll position. A `roots_changed` error shows a notice pointing to settings.
- [x] add `ExtBrowser.openManager()` to the fixtures
- [x] write e2e tests:
  - the manager opens from the popup and shows the roots and seeded items;
  - a bookmark added through `chrome.bookmarks` appears without a reload;
  - the collapse state and the selection survive a refresh;
  - a click selects a row.
- [x] run `npm run check` and `make e2e` - must pass before task 9
- [x] ➕ "Manage bookmarks" sits in a static `#popup-nav` row of the popup. A selection change repaints classes instead of rebuilding rows. Only expanded folders render their children, so collapsed parts of a big library cost nothing. A double-click on a folder toggles it. The `roots_changed` notice (with an "Open settings" button) has no e2e test, because Chromium's permanent folders can't be removed from a test; the handler's unit test covers the error. The root rename/delete restriction comes with the actions in Task 9.

### Task 9: Manager editing
**Files:**
- Modify: `extension/src/ui/manager/manager.ts`
- Modify: `extension/src/ui/manager/manager.css`
- Modify: `extension/e2e/manager.spec.ts`

- [x] add the toolbar actions "New folder" and "New bookmark". They create inside the selected folder, or after the selected bookmark. A new folder starts in inline rename, which holds the refresh gate.
- [x] add inline rename (double-click a folder title, or the row's rename action) and an edit dialog for a bookmark's title and URL. Both hold the gate. Validation errors and browser refusals show inline.
- [x] add "Delete" for the selected item, with a confirmation that names the counts (`countSubtree`) whenever folders or several items are involved. The dialog notes that sync may ask again for large deletions.
- [x] show `StaleTreeError` and `RootLockedError` as a non-blocking notice, then refresh
- [x] write e2e tests:
  - create a folder and type its name: the name sticks, even though `onCreated` triggered a refresh;
  - create a bookmark in it, rename both, edit a URL;
  - an invalid URL is rejected inline;
  - delete a folder with contents after confirming, and nothing is deleted on cancel.
- [x] run `npm run check` and `make e2e` - must pass before task 10
- [x] ➕ The dialogs live in `src/ui/manager/dialogs.ts` and use native `<dialog>`. The edit form has `novalidate`: without it, Chromium's own `type=url` check blocked the submit and showed its tooltip instead of our message (the e2e test caught this). The toolbar's Edit and Delete act on the selection, and roots get neither a row action nor an enabled toolbar button. The notice keeps load errors apart from action results, so a refresh doesn't hide a message the user hasn't read.

### Task 10: Manager search and reveal
**Files:**
- Modify: `extension/src/ui/manager/manager.ts`
- Modify: `extension/src/ui/manager/manager.css`
- Modify: `extension/e2e/manager.spec.ts`

- [ ] add a search box that replaces the tree with a flat list of bookmarks and folders (with paths) while it has text, using `search()` without a limit
- [ ] clicking a result reveals it: the search clears, its ancestors expand, and it is selected and scrolled into view. `?reveal=<id>` does the same on open. Escape clears the search.
- [ ] write e2e tests:
  - find a deeply nested bookmark by part of its URL and reveal it: it is selected and visible;
  - find a folder by name;
  - `manager.html?reveal=<id>` opens with that node revealed.
- [ ] run `npm run check` and `make e2e` - must pass before task 11

### Task 11: Multi-select and drag and drop
**Files:**
- Modify: `extension/src/ui/manager/manager.ts`
- Modify: `extension/src/ui/manager/manager.css`
- Modify: `extension/e2e/manager.spec.ts`
- Modify: `extension/e2e/sync.spec.ts`

- [ ] wire Ctrl/Cmd and Shift clicks to `select()`, show the selection count in the toolbar, and make "Delete" act on the whole selection
- [ ] add HTML5 drag-and-drop on rows:
  - dragging a selected row drags the whole selection; dragging an unselected row drags only that row;
  - `dragstart` calls `dataTransfer.setData('text/plain', ids)` (Firefox won't start a drag without it) and holds the refresh gate;
  - `dragover` calls `preventDefault()` only on allowed targets and sets `dropEffect`;
  - `drop` always calls `preventDefault()`, so Firefox doesn't navigate to the dragged text;
  - `dragend` releases the gate.
- [ ] show a drop-indicator line for `before`/`after` and a highlight for `inside`, with no indicator on refused targets. On drop, call `resolveDrop`, then `moveMany` unless it is a no-op, then keep the moved items selected and visible.
- [ ] write e2e tests for drag and drop (real Chromium move semantics):
  - reorder down and up inside a folder;
  - move into a collapsed folder;
  - move into a root;
  - drag two non-adjacent bookmarks, selected with Ctrl, into a folder: their order is kept;
  - a folder can't be dropped into its own child, and nothing changes.
- [ ] write e2e tests for selection and sync:
  - Ctrl-select two items and delete them: the confirmation counts are correct, and both are gone;
  - **two profiles:** a drag-and-drop move made in profile A's manager arrives in profile B, and B's open manager refreshes by itself (one test, added to `e2e/sync.spec.ts`).
- [ ] run `npm run check` and `make e2e` - must pass before task 12

### Task 12: Verify acceptance criteria
- [ ] verify all seven acceptance criteria from the Overview, each mapped to at least one automated test
- [ ] verify edge cases:
  - Firefox separators and privileged URLs (unit tests over the fake);
  - the Chromium menu folder as a target, and locked against rename, move and delete;
  - a menu folder not yet pinned shows as a root;
  - an empty Mobile root is hidden;
  - a stale tree after a concurrent change;
  - very long titles and URLs.
- [ ] run the full test suite: `make test`
- [ ] run the e2e tests: `make e2e`
- [ ] verify coverage: `npx vitest run --coverage` ≥ 90 % statements for `src/bookmarks` (and unchanged ≥ 90 % for `src/sync`, `src/crypto`, `src/browser`)

### Task 13: [Final] Update documentation
- [ ] update README.md:
  - add a "Finding and organizing bookmarks" section: popup search, bookmark this page, the manager, drag and drop, multi-select;
  - mention the new `activeTab` permission;
  - add `src/bookmarks/` and the manager to the layout block.
- [ ] update CLAUDE.md:
  - `src/bookmarks/` (pure, unit-tested; `src/ui` stays thin) and its coverage target;
  - "UI pages edit bookmarks only through `src/bookmarks/ops.ts`, never through raw `bookmarks.move` indices; roots are locked there";
  - "popup status re-renders must stay inside `#status-app`".
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification**
- **Real Firefox** (`web-ext run`):
  - drag and drop, including around separators and in the Bookmarks Menu;
  - popup search and opening results;
  - "Bookmark this page" under `activeTab`;
  - refused `javascript:` and `file:` URLs.
- **The real toolbar popup** (not opened as a tab):
  - "Bookmark this page" picks up the active tab through `activeTab`;
  - Escape clears the search box, or closes the popup if the browser takes the key first. Either is acceptable.
- **Large libraries (10k bookmarks):**
  - popup search answers within 10 ms per keystroke;
  - manager render and scroll time, and smooth drag and drop;
  - if rendering is slow, consider rendering collapsed folders lazily or a virtualized list.
- **Interplay with sync:**
  - a large multi-delete triggers sync's mass-deletion confirmation, whose counts include folders;
  - a slow `deleteMany` can be split across two sync runs (two confirmations with partial counts);
  - sync running while a drag is in progress.
- **Accessibility:** screen-reader pass over the list semantics and expand buttons; focus visibility; dark mode.

**External systems**
- Store listings: the `activeTab` permission needs a one-line justification on the Chrome Web Store and Firefox AMO ("adds the current page as a bookmark when you click Bookmark this page").
