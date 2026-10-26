// A readable default device name, e.g. "Edge on Windows".

export type BrowserName = 'Brave' | 'Edge' | 'Opera' | 'Vivaldi' | 'Firefox' | 'Chrome' | 'Browser';

/** The browser family from its user agent; Brave hides itself there, so the caller says. */
export function detectBrowser(ua: string, isBrave = false): BrowserName {
  if (isBrave) return 'Brave';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Vivaldi\//.test(ua)) return 'Vivaldi';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  return 'Browser';
}

export function defaultDeviceName(ua: string, isBrave = false): string {
  const browser = detectBrowser(ua, isBrave);
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /CrOS/.test(ua)
        ? 'ChromeOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}
