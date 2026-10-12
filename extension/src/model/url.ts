// URL normalization for matching bookmarks: when a device joins, and to find
// where the current page is already bookmarked. Never used to rewrite stored URLs.

/**
 * Key for "same bookmark" matching: the WHATWG-serialized URL, which
 * lowercases scheme and host, converts IDN hosts to punycode and drops
 * default ports and an empty trailing fragment. Unparseable URLs fall back to the trimmed input.
 */
export function matchKey(raw: string): string {
  const trimmed = raw.trim();
  try {
    const href = new URL(trimmed).href;
    // Browsers disagree on keeping an empty fragment; it never changes the target.
    return href.endsWith('#') ? href.slice(0, -1) : href;
  } catch {
    return trimmed;
  }
}
