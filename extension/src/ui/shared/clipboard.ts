// Feedback for the copy-URL buttons: the button shows ✓ for a moment.
const FLASH_MS = 1500;

export function flashCopied(button: HTMLElement): void {
  const label = button.dataset.label ?? button.textContent ?? '';
  button.dataset.label = label;
  button.textContent = '✓';
  button.classList.add('copied');
  setTimeout(() => {
    button.textContent = label;
    button.classList.remove('copied');
  }, FLASH_MS);
}
