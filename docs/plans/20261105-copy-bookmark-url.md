# Copy bookmark URL

## Overview
- Add a way to copy a bookmark's URL to the clipboard from:
  - the extension popup search results;
  - the extension bookmark manager (tree rows and search results);
  - the Android app (folder lists and search results).
- Today the only way to get a URL is to open it or open the edit dialog and select the
  text. A copy action saves those steps.
- UI-only change. No sync, vault, crypto, API or protocol change, so `docs/protocol.md` and
  the conformance corpus are untouched.

## Context (from discovery)
- **Popup search:** `extension/src/ui/popup/search.ts`. Each result is an `li.result` whose
  `onclick` opens the URL in a new tab. ↑/↓ and Enter work from the input. Styles are in
  `popup.css` (`.result`, `.result-title`, `.result-meta`).
- **Manager:** `extension/src/ui/manager/manager.ts`.
  - `nodeItem()` builds `.node-row` with `.actions` buttons (`data-action="edit"|"delete"`).
    One delegated `click` listener on `main` dispatches them.
  - `renderResults()` builds `li.result[data-reveal]` rows. A click reveals the node in
    the tree.
  - `main`'s delegated click listener checks `[data-reveal]` (search results) **before**
    `.node-row`/`[data-action]`, so a copy branch must come first.
  - `selection` survives into search mode. `treeOrder()` is in `src/bookmarks/tree.ts`.
- **Android:** `ui/bookmarks/BookmarksScreen.kt`: `NodeRow` and `SearchResults` both
  long-press into `vm.showActions(node)`. `BrowserDialogs.kt` renders
  `BrowserDialog.Actions` as a `ModalBottomSheet` of `SheetAction`s (Rename, Edit URL,
  Move, Delete). `EmergencyKitScreen.kt` already copies with `LocalClipboard` and
  `ClipEntry`.
- **Tests:**
  - e2e: `extension/e2e/popup-search.spec.ts` and `manager.spec.ts` (Playwright with a
    real Chromium).
  - Android: `android/app/src/test/.../ui/bookmarks/FolderScreenTest.kt` (Robolectric +
    `FakeCore`).
  - Pure logic: `src/bookmarks/*.test.ts` (vitest).
- **Conventions (CLAUDE.md):**
  - Bookmark UI logic lives in `src/bookmarks/` (pure, unit-tested); `src/ui/**` stays thin
    and is covered by Playwright.
  - Browser APIs go through `ext()`. `navigator.clipboard` is a web API, not an extension
    API, so it doesn't need `ext()`.
  - No runtime dependencies.
  - Android lint runs with `warningsAsErrors`.

## Development Approach
- **testing approach**: Regular (code first, then tests)
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
- run tests after each change
- maintain backward compatibility

## Testing Strategy
- **unit tests:**
  - vitest for the pure helper in `src/bookmarks/`;
  - Robolectric/JVM for Android.
- **e2e tests:**
  - Playwright for the popup and the manager, in the same task as the UI code.
  - Primary method: real readback. Call
    `context.grantPermissions(['clipboard-read', 'clipboard-write'])`; if the unscoped
    grant fails, add `{ origin: 'chrome-extension://' + extensionId }`. Then call
    `await page.bringToFront()` and
    `page.evaluate(() => navigator.clipboard.readText())`.
    - `bringToFront()` is needed because `readText()` fails with "Document is not
      focused" when several pages are open.
    - Each test launches a fresh browser (`workers: 1`), so clipboards don't leak between
      tests.
  - Readback is the only check that the user-activation path works. If it is still
    flaky, stub `navigator.clipboard.writeText` with `addInitScript`, as
    `unsupported.spec.ts` does, and record the argument. Note the deviation here (⚠️).
  - ⚠️ An origin-scoped grant fails ("Permission can't be granted to opaque origins").
    The unscoped grant works and is in `ExtBrowser.clipboard()`. It runs only after the
    copy click, so the copy itself is tested without any granted permission.
  - To check that no tab opened, assert `context.pages().length` is unchanged.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope
- keep plan in sync with actual work done

## Solution Overview
- **Extension: inline button.**
  - Each bookmark row (never a folder) gets a small copy button, `⧉`, with
    `aria-label="Copy URL of <title>"`.
  - It goes in popup search results, in manager tree rows (next to ✎ 🗑) and in manager
    search results.
  - Clicking it calls `navigator.clipboard.writeText(url)` inside the click handler, so it
    has the user activation it needs. **No `clipboardWrite` permission:** `writeText` works
    from a click or keydown handler in both browsers. A new permission triggers an update
    prompt, so add it only if the manual Firefox check in Post-Completion fails.
  - The click must not also open the bookmark (popup), select the row (manager tree) or
    reveal it (manager search).
    - Popup: `stopPropagation` in the button's handler.
    - Manager: a `[data-action="copy"]` branch first in the delegated listener, before
      `[data-reveal]`.
  - Popup focus stays in the search box, so ↑/↓/Enter keep working. The button gets
    `tabindex="-1"`, and its `mousedown` calls `preventDefault()`.
  - Feedback is a short "Copied" state: the button shows ✓ for about 1.5 s. A failure
    shows an error: in the popup in `#popup-search-error`, in the manager through
    `setMessage`.
- **Manager: keyboard copy.** With a non-empty selection and focus outside any text
  field, Ctrl/Cmd+C copies the URLs of the selected bookmarks, one per line, in visible
  order. Folders in the selection are skipped.
  - Acts only in tree mode (`query.trim() === ''`), and only when `document.activeElement`
    is `body` or inside `main`. So it never fires in the search box, in an open dialog or
    in a `contentEditable` element.
  - Key check:
    `ev.key.toLowerCase() === 'c' && (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey`.
  - If nothing copyable is selected, the browser's default copy applies.
- **Popup: no keyboard shortcut.** Ctrl+C in the search box must keep copying the query
  text. Only the button.
- **Android:**
  - Add a **Copy URL** item to the long-press actions sheet, for bookmarks only. The sheet
    is already reachable from folder lists and from search results.
  - Show the item only when `node.url != null`.
  - Copy with `LocalClipboard.current.setClipEntry(ClipEntry(ClipData.newPlainText(...)))`.
    Run it in a scope hoisted to the top of `BrowserDialogs`, outside the `when`, so that
    dismissing the sheet doesn't cancel the copy. Then call
    `vm.copied(announce = Build.VERSION.SDK_INT < 33)` in the same coroutine.
  - Android 13+ shows its own clipboard confirmation. Below that, show a "URL copied"
    snackbar. The SDK decision stays in the composable, so the plain-JUnit VM test can
    cover both branches.
- **Design rationale:**
  - An inline button is discoverable.
  - Android uses the sheet because rows are dense and long-press is already where row
    actions live.
  - The only non-trivial logic, which URLs a selection copies, lives in `src/bookmarks/`,
    so it can be unit-tested.

## Technical Details
- **New pure helper** in `extension/src/bookmarks/tree.ts`, next to `treeOrder`:
  ```ts
  /** URLs of the selected bookmarks, in tree order; folders are skipped. */
  export function selectedUrls(t: LocalTree, ids: ReadonlySet<string>): string[]
  ```
  - It is `treeOrder(t)` filtered to selected bookmarks that have a URL. The visible
    order is a subsequence of the tree order, so it needs no `order` parameter.
  - The caller does `join('\n')`.
- **New thin UI helper** in `extension/src/ui/shared/clipboard.ts`: `flashCopied(button)`
  swaps the label to ✓ and restores it. Both pages share it. Callers use
  `navigator.clipboard.writeText` directly, with no wrapper.
- **Markup:**
  - `button.act[data-action="copy"]` in manager rows;
  - `button.copy[data-action="copy"]` in popup and manager results.
  - Show it on hover and keyboard focus, like `.actions`. In the popup, keep it always
    visible at reduced opacity, since there's no hover on touch.
  - CSS goes only in the pages' existing `.css` files.
- **Android:**
  - New strings `copy_url` and `url_copied` in `res/values/strings.xml`;
  - `url_copied` is special-cased in `BookmarksScreen.kt`, next to `cannot_open` (turn
    that `if` into a small `when`). `Messages.kt`, which maps core error codes, is not
    touched;
  - `vm.copied(announce: Boolean)` dismisses the dialog and sets `message = "url_copied"`
    when `announce` is true;
  - the sheet item's test tag is `action-copy`.

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): tasks achievable within this codebase - code changes, tests, documentation updates
- **Post-Completion** (no checkboxes): items requiring external action - manual testing, changes in consuming projects, deployment configs, third-party verifications

## Implementation Steps

### Task 1: Selected-URLs helper

**Files:**
- Modify: `extension/src/bookmarks/tree.ts`
- Modify: `extension/src/bookmarks/tree.test.ts`

- [x] add `selectedUrls(t, ids)`: `treeOrder(t)` filtered to selected bookmarks with a URL
- [x] write tests: a single bookmark; a multi-selection in tree order, regardless of
      selection order; folders skipped
- [x] write tests for edge cases:
      - an empty selection or only folders → `[]`;
      - an unknown id is ignored;
      - selecting a folder doesn't copy the bookmarks inside it
- [x] run `cd extension && npm run check` (keep `src/bookmarks` coverage ≥ 90 %) - must
      pass before next task

### Task 2: Shared clipboard helper and popup search copy button

**Files:**
- Create: `extension/src/ui/shared/clipboard.ts`
- Modify: `extension/src/ui/popup/search.ts`
- Modify: `extension/src/ui/popup/popup.css`
- Modify: `extension/e2e/popup-search.spec.ts`

- [x] create `flashCopied` in `ui/shared/clipboard.ts`
- [x] add a copy button to each result in `search.ts`:
      - `tabindex="-1"`, with `aria-label` "Copy URL of `${r.title || r.url}`";
      - `mousedown` calls `preventDefault()`, so focus stays in the input;
      - the click calls `stopPropagation`, so the result doesn't open and the popup
        doesn't close, then `navigator.clipboard.writeText(r.url)`;
      - a failure is shown in `#popup-search-error`
- [x] style `.result .copy` in `popup.css`. Keyboard ↑/↓/Enter behavior must not change
- [x] e2e: clicking copy puts the URL on the clipboard (read back after
      `bringToFront()`) and shows ✓
- [x] e2e: after the copy click, no tab has opened (`context.pages().length` unchanged),
      the popup is still open, and ArrowDown still moves the active result
- [x] e2e: Enter on the active result still opens it (existing test stays green)
- [x] run `npm run check` and `make e2e` - must pass before next task

### Task 3: Manager copy (row button, search results, Ctrl/Cmd+C)

**Files:**
- Modify: `extension/src/ui/manager/manager.ts`
- Modify: `extension/src/ui/manager/manager.css`
- Modify: `extension/e2e/manager.spec.ts`

- [x] in `nodeItem()`, add `button.act[data-action="copy"]` before ✎, for bookmarks
      only (not folders, not roots)
- [x] in `renderResults()`, add `button.copy[data-action="copy"][data-url]` for results
      with a URL
- [x] in the delegated `main` click listener, add a first branch for
      `[data-action="copy"]`, ahead of `[data-reveal]`. It copies `data-url`, or the
      row's `tree.nodes.get(id).url`, flashes ✓ and returns
- [x] add a `keydown` handler:
      - it fires only when the key check matches, `query.trim() === ''`,
        `document.activeElement` is `body` or inside `main`, and there is no text
        selection;
      - it copies `selectedUrls(tree, selection.selected).join('\n')` when that's
        non-empty, and calls `preventDefault`; otherwise the browser's default applies;
      - route failures through `setMessage`
      - ➕ on success, the notice says "Copied N URLs." (there's no button to flash)
- [x] e2e: the row button copies the URL without changing the selection, and folders have
      no copy button
- [x] e2e: extend the existing test "deletes a single bookmark without asking, and never
      offers to edit or delete a root" to assert that roots have no copy button either
- [x] e2e: the search result button copies without revealing
- [x] e2e: Ctrl+C with a two-bookmark selection plus a folder copies two lines in order
- [x] e2e: Ctrl+C in `#manager-search` copies the query text, and Ctrl+C in search mode
      doesn't copy the hidden selection
- [x] run `npm run check` and `make e2e` - must pass before next task

### Task 4: Android "Copy URL" sheet action

**Files:**
- Modify: `android/app/src/main/java/io/booksync/android/ui/bookmarks/BrowserDialogs.kt`
- Modify: `android/app/src/main/java/io/booksync/android/ui/bookmarks/BookmarksViewModel.kt`
- Modify: `android/app/src/main/java/io/booksync/android/ui/bookmarks/BookmarksScreen.kt`
- Modify: `android/app/src/main/res/values/strings.xml`
- Modify: `android/app/src/test/java/io/booksync/android/ui/bookmarks/FolderScreenTest.kt`
- Modify: `android/app/src/test/java/io/booksync/android/ui/bookmarks/BookmarksViewModelTest.kt`

- [ ] add the `copy_url` and `url_copied` strings
- [ ] special-case `url_copied` in `BookmarksScreen.kt`, next to `cannot_open` (as a
      `when`)
- [ ] hoist `rememberCoroutineScope()` and `LocalClipboard.current` to the top of
      `BrowserDialogs`
- [ ] in the `Actions` sheet, when `node.url != null`, add
      `SheetAction(R.string.copy_url, "action-copy")`. Its coroutine runs `setClipEntry`
      first, then `vm.copied(announce = Build.VERSION.SDK_INT < 33)`
- [ ] add `vm.copied(announce)`: dismiss the dialog, and set `message = "url_copied"` when
      `announce` is true
- [ ] VM test (plain JUnit): `copied(true)` dismisses and sets the message; `copied(false)`
      dismisses without one
- [ ] Robolectric (default sdk 35):
      - long-press a bookmark row → Copy URL → the system clipboard (via
        `ClipboardManager`) holds the URL, and no snackbar shows;
      - the same from a search result;
      - folders show no Copy URL item
- [ ] Robolectric: one `@Config(sdk = [32])` case asserts the "URL copied" snackbar
- [ ] run `make android-test` (lint is `warningsAsErrors`) - must pass before next task

### Task 5: Verify acceptance criteria
- [ ] verify that copy works in the popup search, the manager tree, the manager search and
      Android (folders and search)
- [ ] verify the edge cases: folders and roots never offer copy, a copy click never
      opens, selects or reveals, and Ctrl+C in a text field copies text as usual
- [ ] run the full test suite: `make test` and `make lint`
- [ ] run the e2e tests: `make e2e`
- [ ] verify coverage: `npx vitest run --coverage` (≥ 90 % for `src/bookmarks`)

### Task 6: [Final] Update documentation
- [ ] `docs/user-guide.md`: mention the copy button in popup search and in the manager,
      and Ctrl/Cmd+C on the selection
- [ ] `docs/android.md:28`: add **Copy URL** to "Rename, Edit URL, Move and Delete"
- [ ] update CLAUDE.md only if a new pattern emerged (for example the clipboard helper
      location)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification:**
- Firefox desktop: the popup and manager copy buttons work without a `clipboardWrite`
  permission. Firefox is otherwise covered only by fakes. If they don't work, add the
  permission (➕) and mention the update prompt in the release notes.
- Edge (`make e2e-edge`): a quick check.
- Android device on API 33+: the system clipboard preview appears and the app shows no
  duplicate toast. On API ≤ 32, the "URL copied" message shows.
