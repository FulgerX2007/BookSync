import { describe, expect, it } from 'vitest';
import { browser, idOf } from '../../test/bookmark-trees';
import { MENU_FOLDER_TITLE } from '../browser/chromium';
import { countSubtree, folderOptions, isAncestor, isRootId, normalizeSelection, pathOf, rootIds, treeOrder, visibleOrder } from './tree';

/** Toolbar: Work/{Docs, Deep/{Deeper/{Bottom}}}, Example; Other: Misc */
async function sample(flavor: 'chromium' | 'firefox' = 'chromium') {
  const b = browser(flavor);
  const r = b.fake.roots();
  const work = await b.fake.addFolder(r.toolbar, 'Work');
  await b.fake.addBookmark(work.id, 'Docs', 'https://docs.example/');
  const deep = await b.fake.addFolder(work.id, 'Deep');
  const deeper = await b.fake.addFolder(deep.id, 'Deeper');
  await b.fake.addBookmark(deeper.id, 'Bottom', 'https://bottom.example/');
  await b.fake.addBookmark(r.toolbar, 'Example', 'https://example.com/');
  await b.fake.addBookmark(r.other, 'Misc', 'https://misc.example/');
  return { ...b, t: await b.tree() };
}

describe('roots', () => {
  it('lists the Chromium roots present, skipping the absent menu folder and the hidden Mobile root', async () => {
    const b = browser('chromium');
    const t = await b.tree();
    expect(rootIds(t)).toEqual(['1', '2']);
    expect(isRootId(t, '1')).toBe(true);
  });

  it('treats the Chromium menu folder as a root, between the toolbar and Other', async () => {
    const b = browser('chromium');
    const menu = await b.fake.addFolder('2', MENU_FOLDER_TITLE);
    b.fake.revealMobile('Phone', 'https://phone.example/');
    const t = await b.tree();
    expect(rootIds(t)).toEqual(['1', menu.id, '2', '3']);
    expect(isRootId(t, menu.id)).toBe(true);
    expect(t.nodes.get('2')!.children).not.toContain(menu.id);
  });

  it('lists the Firefox roots in canonical order', async () => {
    const t = await browser('firefox').tree();
    expect(rootIds(t)).toEqual(['toolbar_____', 'menu________', 'unfiled_____', 'mobile______']);
  });

  it('does not count ordinary or unknown nodes as roots', async () => {
    const { t } = await sample();
    expect(isRootId(t, idOf(t, 'Work'))).toBe(false);
    expect(isRootId(t, 'nope')).toBe(false);
  });
});

describe('pathOf and isAncestor', () => {
  it('returns the folder titles above a node, root first', async () => {
    const { t } = await sample();
    expect(pathOf(t, idOf(t, 'Bottom'))).toEqual(['Bookmarks bar', 'Work', 'Deep', 'Deeper']);
    expect(pathOf(t, idOf(t, 'Misc'))).toEqual(['Other bookmarks']);
    expect(pathOf(t, '1')).toEqual([]);
    expect(pathOf(t, 'nope')).toEqual([]);
  });

  it('knows ancestry, including a node being its own ancestor', async () => {
    const { t } = await sample();
    const work = idOf(t, 'Work');
    const bottom = idOf(t, 'Bottom');
    expect(isAncestor(t, work, bottom)).toBe(true);
    expect(isAncestor(t, '1', bottom)).toBe(true);
    expect(isAncestor(t, bottom, bottom)).toBe(true);
    expect(isAncestor(t, bottom, work)).toBe(false);
    expect(isAncestor(t, idOf(t, 'Example'), bottom)).toBe(false);
    expect(isAncestor(t, work, 'nope')).toBe(false);
  });

  it('handles deep nesting', async () => {
    const b = browser('firefox');
    let parent = b.fake.roots().toolbar;
    for (let i = 0; i < 40; i++) parent = (await b.fake.addFolder(parent, `L${i}`)).id;
    await b.fake.addBookmark(parent, 'Leaf', 'https://leaf.example/');
    const t = await b.tree();
    expect(pathOf(t, idOf(t, 'Leaf'))).toHaveLength(41);
  });
});

describe('treeOrder and visibleOrder', () => {
  it('walks every node depth-first', async () => {
    const { t } = await sample();
    const titles = treeOrder(t).map((id) => t.nodes.get(id)!.title);
    expect(titles).toEqual(['Bookmarks bar', 'Work', 'Docs', 'Deep', 'Deeper', 'Bottom', 'Example', 'Other bookmarks', 'Misc']);
  });

  it('shows roots always and children only of expanded folders', async () => {
    const { t } = await sample();
    const names = (expanded: string[]) => visibleOrder(t, new Set(expanded.map((x) => (x.length > 2 ? idOf(t, x) : x)))).map((id) => t.nodes.get(id)!.title);
    expect(names([])).toEqual(['Bookmarks bar', 'Other bookmarks']);
    expect(names(['1'])).toEqual(['Bookmarks bar', 'Work', 'Example', 'Other bookmarks']);
    expect(names(['1', 'Work'])).toEqual(['Bookmarks bar', 'Work', 'Docs', 'Deep', 'Example', 'Other bookmarks']);
    // An expanded folder under a collapsed one stays hidden.
    expect(names(['Work', 'Deep'])).toEqual(['Bookmarks bar', 'Other bookmarks']);
  });

  it('copes with empty folders', async () => {
    const b = browser('chromium');
    const empty = await b.fake.addFolder('1', 'Empty');
    const t = await b.tree();
    expect(visibleOrder(t, new Set(['1', empty.id]))).toEqual(['1', empty.id, '2']);
  });
});

describe('normalizeSelection', () => {
  it('drops roots, unknown ids, duplicates and anything inside a selected folder, in tree order', async () => {
    const { t } = await sample();
    const [work, docs, bottom, example, misc] = [idOf(t, 'Work'), idOf(t, 'Docs'), idOf(t, 'Bottom'), idOf(t, 'Example'), idOf(t, 'Misc')];
    expect(normalizeSelection(t, [misc, docs, work, bottom, '1', 'nope', misc, example])).toEqual([work, example, misc]);
    expect(normalizeSelection(t, [misc, docs])).toEqual([docs, misc]);
    expect(normalizeSelection(t, ['1', '2'])).toEqual([]);
  });
});

describe('folderOptions', () => {
  it('lists every folder in tree order with depth and indented labels', async () => {
    const { t } = await sample();
    expect(folderOptions(t).map((o) => [o.title, o.depth, o.label])).toEqual([
      ['Bookmarks bar', 0, 'Bookmarks bar'],
      ['Work', 1, '  Work'],
      ['Deep', 2, '    Deep'],
      ['Deeper', 3, '      Deeper'],
      ['Other bookmarks', 0, 'Other bookmarks'],
    ]);
  });

  it('names untitled folders and uses the Firefox root names', async () => {
    const b = browser('firefox');
    await b.fake.addFolder(b.fake.roots().toolbar, '');
    const t = await b.tree();
    const opts = folderOptions(t);
    expect(opts.map((o) => o.title)).toEqual(['Bookmarks Toolbar', 'Untitled folder', 'Bookmarks Menu', 'Other Bookmarks', 'Mobile Bookmarks']);
  });
});

describe('countSubtree', () => {
  it('counts the selected nodes and their contents once', async () => {
    const { t } = await sample();
    const [work, docs, example] = [idOf(t, 'Work'), idOf(t, 'Docs'), idOf(t, 'Example')];
    // Work holds Docs, Deep, Deeper, Bottom.
    expect(countSubtree(t, [work])).toEqual({ bookmarks: 2, folders: 3 });
    expect(countSubtree(t, [work, docs, example])).toEqual({ bookmarks: 3, folders: 3 });
    expect(countSubtree(t, ['1', 'nope'])).toEqual({ bookmarks: 0, folders: 0 });
  });
});
