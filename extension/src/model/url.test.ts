import { describe, expect, it } from 'vitest';
import { matchKey } from './url';

describe('matchKey', () => {
  it.each([
    ['https://Example.COM/Path', 'https://example.com/Path'],
    ['https://example.com', 'https://example.com/'],
    ['https://example.com:443/x', 'https://example.com/x'],
    ['http://example.com:80/', 'http://example.com/'],
    ['http://example.com:8080/', 'http://example.com:8080/'],
    ['  https://example.com/  ', 'https://example.com/'],
    ['https://bücher.example/', 'https://xn--bcher-kva.example/'],
    ['HTTPS://EXAMPLE.COM/?q=A', 'https://example.com/?q=A'],
  ])('%s → %s', (input, want) => {
    expect(matchKey(input)).toBe(want);
  });

  it('keeps unparseable input as trimmed text', () => {
    expect(matchKey('  not a url ')).toBe('not a url');
  });

  it('keeps bookmarklets distinct', () => {
    expect(matchKey('javascript:alert(1)')).not.toBe(matchKey('javascript:alert(2)'));
  });
});
