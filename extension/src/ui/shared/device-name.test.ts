import { describe, expect, it } from 'vitest';
import { defaultDeviceName } from './device-name';

describe('defaultDeviceName', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0', 'Edge on Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox on Linux'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36', 'Chrome on macOS'],
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 OPR/120.0', 'Opera on Windows'],
    ['Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36', 'Chrome on ChromeOS'],
    ['curl/8', 'Browser'],
  ])('%s', (ua, want) => {
    expect(defaultDeviceName(ua)).toBe(want);
  });

  it('recognizes Brave, which hides itself in the user agent', () => {
    expect(defaultDeviceName('Mozilla/5.0 (Windows NT 10.0) Chrome/141.0', true)).toBe('Brave on Windows');
  });
});
