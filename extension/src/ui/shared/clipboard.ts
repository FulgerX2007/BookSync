// Copies text to the clipboard from a UI page. Call copyText directly in the click
// handler, with no await before it: Firefox drops the user gesture after an await,
// and the write needs it.
import { errorText } from './errors';

export type CopyResult = { ok: true } | { ok: false; error: string };
export type ClipboardWrite = (text: string) => Promise<void>;

/** How long a copy button shows its "Copied" state. */
export const COPIED_MS = 1200;

const defaultWrite: ClipboardWrite = (text) => {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard) throw new Error('Clipboard is not available');
  return clipboard.writeText(text); // a method call, so `this` stays bound
};

/** Never throws. `write` runs synchronously, inside the caller's gesture. */
export function copyText(text: string, write: ClipboardWrite = defaultWrite): Promise<CopyResult> {
  if (text === '') return Promise.resolve({ ok: false, error: 'Nothing to copy' });
  let pending: Promise<void>;
  try {
    pending = write(text);
  } catch (e) {
    return Promise.resolve({ ok: false, error: errorText(e) });
  }
  return pending.then(
    (): CopyResult => ({ ok: true }),
    (e: unknown): CopyResult => ({ ok: false, error: errorText(e) }),
  );
}

/** Shows "✓ Copied" on a copy button for COPIED_MS. A re-render may drop it early. */
export function showCopied(button: HTMLElement): void {
  const { textContent, title } = button;
  button.textContent = '✓';
  button.title = 'Copied';
  button.classList.add('copied');
  setTimeout(() => {
    button.textContent = textContent;
    button.title = title;
    button.classList.remove('copied');
  }, COPIED_MS);
}
