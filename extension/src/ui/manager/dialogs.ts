// Modal dialogs for the bookmark manager (native <dialog>, no framework).
import { h } from '../shared/dom';
import { errorText } from '../shared/errors';

function modal(dialog: HTMLDialogElement): void {
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

export interface BookmarkDialogOptions {
  heading: string;
  title: string;
  url: string;
  submitLabel: string;
  /** Throws to keep the dialog open and show the message (e.g. an invalid URL). */
  onSubmit: (title: string, url: string) => Promise<void>;
}

/** Title + URL form; resolves once the dialog closes (saved or cancelled). */
export function bookmarkDialog(o: BookmarkDialogOptions): Promise<void> {
  return new Promise((resolve) => {
    const title = h('input', { id: 'edit-title', type: 'text', value: o.title, autocomplete: 'off' });
    const url = h('input', { id: 'edit-url', type: 'url', value: o.url, autocomplete: 'off', spellcheck: 'false' });
    const error = h('div', { id: 'edit-error', class: 'error', role: 'alert' });
    const save = h('button', { id: 'edit-save', type: 'submit', class: 'primary' }, o.submitLabel);
    const dialog = h(
      'dialog',
      { id: 'edit-dialog', 'aria-labelledby': 'edit-heading' },
      h(
        'form',
        // Our own URL check (parseUrl) gives the same message in every browser.
        { method: 'dialog', novalidate: true },
        h('h2', { id: 'edit-heading' }, o.heading),
        h('label', { for: 'edit-title' }, 'Name'),
        title,
        h('label', { for: 'edit-url' }, 'URL'),
        url,
        error,
        h('div', { class: 'row end' }, h('button', { id: 'edit-cancel', type: 'button', onclick: () => dialog.close() }, 'Cancel'), save),
      ),
    );
    dialog.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      save.disabled = true;
      error.textContent = '';
      try {
        await o.onSubmit(title.value.trim(), url.value.trim());
        dialog.close();
      } catch (e) {
        error.textContent = errorText(e);
      } finally {
        save.disabled = false;
      }
    });
    dialog.addEventListener('close', () => resolve());
    modal(dialog);
    (o.title ? url : title).focus();
  });
}

/** Asks a yes/no question; resolves true only for the confirm button. */
export function confirmDialog(question: string, detail: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    let confirmed = false;
    const dialog = h(
      'dialog',
      { id: 'confirm-dialog', 'aria-labelledby': 'confirm-question' },
      h('h2', { id: 'confirm-question' }, question),
      h('p', { class: 'muted' }, detail),
      h(
        'div',
        { class: 'row end' },
        h('button', { id: 'confirm-cancel', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        h(
          'button',
          {
            id: 'confirm-ok',
            type: 'button',
            class: 'danger',
            onclick: () => {
              confirmed = true;
              dialog.close();
            },
          },
          confirmLabel,
        ),
      ),
    );
    dialog.addEventListener('close', () => resolve(confirmed));
    modal(dialog);
    byIdIn(dialog, 'confirm-cancel')?.focus();
  });
}

function byIdIn(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector(`#${id}`);
}
