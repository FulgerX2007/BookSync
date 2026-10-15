import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { browser } from '../../test/bookmark-trees';
import { MENU_FOLDER_TITLE } from '../browser/chromium';
import { ROOT_MENU, ROOT_MOBILE, ROOT_OTHER, ROOT_TOOLBAR } from '../model/vault';
import { StateStore } from '../storage/state';
import { registerBookmarkHandlers } from './bookmarks';
import { Router } from './router';

let n = 0;
async function setup(flavor: 'chromium' | 'firefox') {
  const b = browser(flavor);
  const state = await StateStore.open(`bookmark-roots-${n++}`);
  const router = new Router();
  registerBookmarkHandlers(router, { adapter: b.adapter, state });
  return { ...b, state, roots: () => router.dispatch({ type: 'bookmarkRoots' }) };
}

describe('bookmarkRoots', () => {
  it('resolves the roots when nothing is pinned (signed out, or before the first sync)', async () => {
    const { roots } = await setup('chromium');
    expect(await roots()).toEqual({ ok: true, data: { [ROOT_TOOLBAR]: '1', [ROOT_OTHER]: '2' } });
  });

  it('returns the pinned roots sync uses', async () => {
    const { fake, state, roots } = await setup('chromium');
    fake.revealMobile('Phone', 'https://phone.example/');
    await state.updateSync({ rootPins: { [ROOT_TOOLBAR]: '1', [ROOT_OTHER]: '2', [ROOT_MOBILE]: '3' } });
    expect(await roots()).toEqual({ ok: true, data: { [ROOT_TOOLBAR]: '1', [ROOT_OTHER]: '2', [ROOT_MOBILE]: '3' } });
  });

  it('adds a Bookmarks Menu folder sync has not pinned yet, so it never reads as an ordinary folder', async () => {
    const { fake, state, roots } = await setup('chromium');
    await state.updateSync({ rootPins: { [ROOT_TOOLBAR]: '1', [ROOT_OTHER]: '2' } });
    const menu = await fake.addFolder('2', MENU_FOLDER_TITLE);
    expect(await roots()).toEqual({ ok: true, data: { [ROOT_TOOLBAR]: '1', [ROOT_MENU]: menu.id, [ROOT_OTHER]: '2' } });
  });

  it('reports vanished pinned roots as roots_changed', async () => {
    const { fake, state, roots } = await setup('chromium');
    await state.updateSync({ rootPins: { [ROOT_TOOLBAR]: '1', [ROOT_OTHER]: '2' } });
    fake.dropRoot('2');
    expect(await roots()).toEqual({ ok: false, error: { code: 'roots_changed', message: expect.stringMatching(/settings/) } });
  });

  it('returns the Firefox roots', async () => {
    const { roots } = await setup('firefox');
    expect(await roots()).toEqual({ ok: true, data: { [ROOT_TOOLBAR]: 'toolbar_____', [ROOT_MENU]: 'menu________', [ROOT_OTHER]: 'unfiled_____', [ROOT_MOBILE]: 'mobile______' } });
  });

  it('never writes sync state or bookmarks', async () => {
    const { fake, state, roots } = await setup('chromium');
    await fake.addFolder('2', MENU_FOLDER_TITLE);
    const before = await state.getSync();
    const writes = fake.writes;
    await roots();
    await roots();
    expect(await state.getSync()).toEqual(before);
    expect(fake.writes).toBe(writes);
  });
});
