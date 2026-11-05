# Copy URL button in popup search and manager

## Overview
- Add a "Copy URL" button to bookmark entries in the extension so a user can put a
  bookmark's URL on the clipboard without opening it.
- Where it appears:
  - popup search results (`#popup-results`);
  - manager tree rows for bookmarks (next to `✎` and `🗑`);
  - manager search results (`#results`).
- Behavior:
  - copying never opens, reveals or selects the bookmark;
  - the popup stays open and keyboard focus stays in the search box;
  - a short "Copied" confirmation is shown;
  - a failure shows in the page's existing error area;
  - no new manifest permission.
- Scope: extension only. Android is out of scope (see Post-Completion).

## Context (from discovery)
- `extension/src/ui/popup/search.ts`:
  - each result is an `<li role="option">` whose `onclick` opens the URL in a new tab and
    closes the popup;
  - errors go to `#popup-search-error`;
  - keyboard focus stays in `#popup-search` (`aria-activedescendant`);
  - `render()` rebuilds every `<li>` on each keystroke, arrow key and refresh.
- `extension/src/ui/manager/manager.ts`:
  - `nodeItem()` builds `.node-row` with a `.actions` span (`data-action="edit"` /
    `"delete"`);
  - `renderResults()` builds `.result[data-reveal]`;
  - the delegated `main` click handler checks `[data-toggle]` and `[data-reveal]` first,
    then `.node-row` and `dataset.action`;
  - the `dblclick` handler ignores `[data-action]`;
  - messages go through `setMessage()`.
- `extension/src/ui/manager/manager.css` holds `.actions`, `.act` (shown on hover,
  selection or focus-within) and `.result`. `extension/src/ui/popup/popup.css` holds
  `.result`, `.result-title` and `.result-meta`.
- No clipboard code exists in the extension yet. `navigator.clipboard.writeText` works
  on extension pages during a user gesture in Chromium and Firefox without
  `clipboardWrite`.
- e2e: `extension/e2e/popup-search.spec.ts`, `manager.spec.ts`, `fixtures.ts`
  (`launchPersistentContext`). It has no clipboard permission grant yet.
- Conventions (CLAUDE.md):
  - `src/ui/**` stays thin, is excluded from vitest coverage and is covered by
    Playwright;
  - `src/ui/shared/` already holds unit-tested helpers (`history.test.ts`,
    `device-name.test.ts`);
  - no runtime dependencies;
  - browser *extension* APIs go through `ext()`. The clipboard is a web API, so it
    doesn't.

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
- run tests after each change (`cd extension && npm run check`)
- maintain backward compatibility

## Testing Strategy
- **unit tests** (vitest), in `src/ui/shared/clipboard.test.ts`, with an injected
  writer. Cover:
  - success;
  - rejection;
  - a missing clipboard API;
  - empty text;
  - **the writer is called synchronously**, before the returned promise is awaited.
    This guards the Firefox user-gesture rule.
- **e2e tests** (Playwright, real Chromium):
  - **Reading the clipboard (spike first, in Task 2):** grant
    `['clipboard-read', 'clipboard-write']` on the browser context with origin
    `` `chrome-extension://${extensionId}` ``, then read `navigator.clipboard.readText()`
    in the page. Keep the grant in the spec files, not in `fixtures.ts`, unless both
    specs need it.
  - **Fallback if the grant doesn't work for extension origins:** before the click,
    `page.evaluate` wraps `navigator.clipboard.writeText` so it records its argument and
    then calls the original. Assert on the recorded text, plus the "Copied" state, which
    appears only if the real write resolved.
  - **Assertion order:** assert the clipboard value first, then the transient "Copied"
    state. The feedback duration is a named constant (`COPIED_MS`).
  - **Failure path:** in each page, `page.evaluate` makes `writeText` reject. Assert
    that the error text appears and that nothing opened, revealed or changed selection.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope
- keep plan in sync with actual work done

## Solution Overview
- **Shared helper (approach A).** `src/ui/shared/clipboard.ts` exports
  `copyText(text, write?)`.
  - It returns `{ ok: true } | { ok: false, error: string }` and never throws. Error
    text goes through `errorText`.
  - `write` is invoked **synchronously** inside `copyText`, with no `await` before the
    call. Callers call `copyText` directly in the click handler, so Firefox keeps the
    user gesture (the same rule as host-permission requests).
- **Why not through the background:** an offscreen document, a `clipboardWrite`
  permission and a new `Protocol` message are not needed.
- **Feedback:**
  - The button briefly changes from `⧉` to `✓` (title "Copied") for `COPIED_MS`
    (~1.2 s), using a local page timer.
  - The manager also writes "Copied" to a polite live region, so screen readers announce
    it.
  - A failure goes to `#popup-search-error` (popup) or `setMessage` (manager).
  - On success, the popup clears `#popup-search-error`, as `open` does.
  - Accepted limitation: if a re-render (keystroke, sync refresh) lands within
    `COPIED_MS`, the `✓` disappears early. The revert timer then writes to a detached
    node, which is harmless. The refresh gate is not held for a copy.
- **Event isolation:**
  - Popup: the button's `onclick` calls `stopPropagation()`, so the `<li>` doesn't open
    the URL. Its `onmousedown` calls `preventDefault()`, so focus never leaves
    `#popup-search`, and arrows and Enter keep working after a copy.
  - Manager: **one** copy branch at the very top of the delegated click handler, before
    `[data-toggle]`, `[data-reveal]` and the row selection. It finds
    `target.closest('[data-action="copy"]')`, reads `data-id` and copies
    `tree.nodes.get(id)?.url`. That is the exact current vault URL; there is no
    `data-url` attribute that could go stale. Then it returns. `dblclick` already
    ignores `[data-action]`.

## Technical Details
- `clipboard.ts`:
  ```ts
  export type CopyResult = { ok: true } | { ok: false; error: string };
  const defaultWrite = (t: string): Promise<void> => {
    const c = globalThis.navigator?.clipboard;
    if (!c) throw new Error('Clipboard is not available');
    return c.writeText(t); // method call: keeps `this` bound
  };
  export function copyText(text: string, write: (t: string) => Promise<void> = defaultWrite): Promise<CopyResult>
  ```
  - `copyText` is not `async` at the call site of `write`. It calls `write(text)`
    synchronously inside a `try`, then chains on the promise.
  - A synchronous throw and a rejection both map to `{ ok: false, error }`.
  - Empty text gives `{ ok: false, error: 'Nothing to copy' }`, and the writer is not
    called.
- The popup result `<li>` gets a trailing
  `<button type="button" class="copy" tabindex="-1" aria-hidden="true" title="Copy URL">⧉</button>`:
  - it has no `aria-label`. Inside `role="option"` its children are presentational, so
    a label would leak into the option's name;
  - it is mouse-only, and e2e targets it with `.copy`;
  - it is shown on hover and on the active (`aria-selected="true"`) row.
- Manager tree row: a third `.act` button,
  `<button type="button" class="act" data-action="copy" data-id="<id>" aria-label="Copy URL of <title>" title="Copy URL">⧉</button>`,
  for bookmarks only (folders and roots get none).
- Manager search result: the same `.act` copy button inside `.result[data-reveal]`, for
  bookmark results only.
- Manager live region: a visually hidden `<div id="manager-live" aria-live="polite">`.
  Its text is set to "Copied" on success; clear it first so a repeat copy is announced
  again.
- CSS: popup `.result` becomes a flex row so the button sits at the right. Manager
  reuses `.act`; `.result` gets `:hover` / `:focus-within` reveal. Add a shared
  visually-hidden utility if none exists in `base.css`.

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): extension code, unit tests, e2e tests,
  docs.
- **Post-Completion** (no checkboxes): manual Firefox check, popup keyboard and
  screen-reader copy, Android follow-up.

## Implementation Steps

### Task 1: Add the shared clipboard helper

**Files:**
- Create: `extension/src/ui/shared/clipboard.ts`
- Create: `extension/src/ui/shared/clipboard.test.ts`

- [ ] create `copyText(text, write?)` returning `CopyResult`. `defaultWrite` calls
      `navigator.clipboard.writeText(t)` as a method; `write` is invoked synchronously
- [ ] map a synchronous throw or a rejection through `errorText`; handle a missing
      clipboard API and empty text
- [ ] write tests: success calls the writer with the exact text
- [ ] write tests: the writer is called before the returned promise is awaited
      (synchronous call)
- [ ] write tests: writer rejects, writer throws synchronously, clipboard API missing
      (default writer with no `navigator.clipboard`), empty text (writer not called)
- [ ] run `cd extension && npm run check` - must pass before task 2

### Task 2: Copy button in popup search results

**Files:**
- Modify: `extension/src/ui/popup/search.ts`
- Modify: `extension/src/ui/popup/popup.css`
- Modify: `extension/e2e/popup-search.spec.ts`

- [ ] spike: grant clipboard permissions for the extension origin and read the
      clipboard back in the popup page. If that fails, use the wrap-and-record
      fallback (Testing Strategy) and note it here with ⚠️
- [ ] append the `aria-hidden` and `tabindex="-1"` copy button to each result `<li>`.
      `onmousedown` calls `preventDefault()`; `onclick` calls `stopPropagation()` and
      then `copyText(r.url)` directly
- [ ] on success, clear `#popup-search-error` and show `✓`/"Copied" for `COPIED_MS`;
      on failure, write to `#popup-search-error`
- [ ] style it: `.result` as a flex row, the button visible on hover and on
      `[aria-selected='true']`
- [ ] e2e: clicking `.copy` puts the bookmark URL on the clipboard (asserted first),
      then shows "Copied". The popup is not closed and the tab count is unchanged
- [ ] e2e: after a copy, `#popup-search` is still focused and ArrowDown still moves
      `aria-selected`
- [ ] e2e: a rejected `writeText` shows the error in `#popup-search-error`, and nothing
      opens
- [ ] e2e: clicking the row elsewhere still opens the bookmark (regression)
- [ ] run `npm run check` and `make e2e` - must pass before task 3

### Task 3: Copy action on manager tree rows

**Files:**
- Modify: `extension/src/ui/manager/manager.ts`
- Modify: `extension/src/ui/manager/manager.html` (live region)
- Modify: `extension/src/ui/manager/manager.css` (if needed)
- Modify: `extension/e2e/manager.spec.ts`

- [ ] add the `#manager-live` polite, visually hidden live region
- [ ] add the single copy branch at the top of the `main` click handler:
      `closest('[data-action="copy"]')`, then `data-id`, then `tree.nodes.get(id)?.url`,
      then `copyText`, then `return`. Show button feedback and the live-region text on
      success, and `setMessage` on failure
- [ ] in `nodeItem()`, add the `data-action="copy"` `data-id` `.act` button for
      bookmarks only, before `✎`
- [ ] e2e: copying a bookmark row puts its URL on the clipboard, shows "Copied", and
      leaves the selection unchanged
- [ ] e2e: folders and roots show no copy button
- [ ] e2e: a rejected `writeText` shows the error through the manager notice, and the
      selection is unchanged
- [ ] run `npm run check` and `make e2e` - must pass before task 4

### Task 4: Copy button on manager search results

**Files:**
- Modify: `extension/src/ui/manager/manager.ts`
- Modify: `extension/src/ui/manager/manager.css`
- Modify: `extension/e2e/manager.spec.ts`

- [ ] in `renderResults()`, add the same copy `.act` button (`data-id`) to bookmark
      results. Task 3's top-of-handler branch already handles it, before
      `[data-reveal]`
- [ ] show the button on `.result:hover` / `:focus-within`
- [ ] e2e: searching, then copying a result, puts its URL on the clipboard, keeps the
      result list (no reveal), and shows "Copied"
- [ ] e2e: clicking the result elsewhere still reveals it (regression)
- [ ] run `npm run check` and `make e2e` - must pass before task 5

### Task 5: Verify acceptance criteria
- [ ] verify the popup search, manager tree and manager search all copy the exact vault
      URL
- [ ] verify copy never opens, reveals or selects, the popup stays open, and popup focus
      stays in the search box
- [ ] verify no manifest permission changed (`scripts/manifest.mjs` diff is empty)
- [ ] run the full suite: `make test`
- [ ] run e2e: `make e2e`
- [ ] verify coverage: `npx vitest run --coverage` (thresholds unchanged; `src/ui` is
      excluded)

### Task 6: [Final] Update documentation
- [ ] mention copying URLs in `docs/user-guide.md` (popup search and manager sections)
- [ ] add a CLAUDE.md note: "clipboard writes go through `ui/shared/clipboard.ts`,
      called synchronously in the click; a button inside `role=option` is
      `aria-hidden`, mouse-only and `mousedown`-`preventDefault`"
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification:**
- Firefox: load the built extension, and check that copy works from the popup and the
  manager. e2e runs only on Chromium; Firefox's gesture rules are the main risk.
- Edge (`make e2e-edge`), if available. Clipboard permission grants may behave
  differently there.
- Screen reader in the manager: "Copied" is announced.

**Deferred by design:**
- Keyboard and screen-reader copying in the popup. The button is `aria-hidden` and
  mouse-only because of the listbox pattern. If it's wanted, add a shortcut on the
  active result as a separate change.

**Follow-ups:**
- Android: matching copy actions in the search and bookmark list screens, using the
  existing `LocalClipboard`, as in `EmergencyKitScreen.kt`.
