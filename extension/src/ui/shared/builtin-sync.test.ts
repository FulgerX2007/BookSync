import { describe, expect, it } from 'vitest';
import { builtinSyncHelp } from './builtin-sync';
import { detectBrowser, type BrowserName } from './device-name';

describe('builtinSyncHelp', () => {
  it('tells every browser where its bookmark sync is switched off', () => {
    const browsers: BrowserName[] = ['Chrome', 'Edge', 'Brave', 'Firefox', 'Opera', 'Vivaldi', 'Browser'];
    for (const b of browsers) {
      const help = builtinSyncHelp(b);
      expect(help.step).not.toBe('');
      expect(help.owner).not.toBe('');
    }
  });

  it('points Edge at Favorites in its profile sync settings', () => {
    const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0';
    expect(builtinSyncHelp(detectBrowser(edge))).toMatchObject({ owner: 'Edge’s', address: 'edge://settings/profiles/sync', step: 'Turn off Favorites.' });
  });

  it('uses Brave Sync for Brave, which the user agent hides', () => {
    expect(builtinSyncHelp(detectBrowser('Mozilla/5.0 Chrome/141.0', true)).address).toBe('brave://settings/braveSync/setup');
  });

  it('points Firefox at its sync preferences', () => {
    expect(builtinSyncHelp(detectBrowser('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0')).address).toBe('about:preferences#sync');
  });
});
