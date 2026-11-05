import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

describe('copyText', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('writes the exact text', async () => {
    const write = vi.fn(() => Promise.resolve());
    expect(await copyText('https://example.com/a?b#c', write)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledWith('https://example.com/a?b#c');
  });

  it('calls the writer synchronously, inside the user gesture', () => {
    const write = vi.fn(() => Promise.resolve());
    void copyText('https://example.com', write);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected write', async () => {
    const write = () => Promise.reject(new Error('Document is not focused.'));
    expect(await copyText('https://example.com', write)).toEqual({ ok: false, error: 'Document is not focused.' });
  });

  it('reports a writer that throws synchronously', async () => {
    const write = (): Promise<void> => {
      throw new Error('boom');
    };
    expect(await copyText('https://example.com', write)).toEqual({ ok: false, error: 'boom' });
  });

  it('reports a missing clipboard API', async () => {
    vi.stubGlobal('navigator', {});
    expect(await copyText('https://example.com')).toEqual({ ok: false, error: 'Clipboard is not available' });
  });

  it('calls navigator.clipboard.writeText as a method', async () => {
    const clipboard = {
      text: '',
      writeText(this: { text: string }, t: string) {
        this.text = t;
        return Promise.resolve();
      },
    };
    vi.stubGlobal('navigator', { clipboard });
    expect(await copyText('https://example.com')).toEqual({ ok: true });
    expect(clipboard.text).toBe('https://example.com');
  });

  it('refuses empty text without writing', async () => {
    const write = vi.fn(() => Promise.resolve());
    expect(await copyText('', write)).toEqual({ ok: false, error: 'Nothing to copy' });
    expect(write).not.toHaveBeenCalled();
  });
});
