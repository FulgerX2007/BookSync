// URL normalization used only to match bookmarks when a device joins.
// Never used to rewrite stored URLs.

/**
 * Key for "same bookmark" matching: the WHATWG-serialized URL, which
 * lowercases scheme and host, converts IDN hosts to punycode and drops
 * default ports. Unparseable URLs fall back to the trimmed input.
 */
export function matchKey(raw: string): string {
  const trimmed = raw.trim();
  try {
    return new URL(trimmed).href;
  } catch {
    return trimmed;
  }
}
