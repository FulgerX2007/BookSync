import { describe, expect, it } from 'vitest';
import { browser } from '../../test/bookmark-trees';
import type { LocalNode, LocalTree } from '../browser/adapter';
import { ROOT_TOOLBAR } from '../model/vault';
import { createSearchIndex, normalize, search, type SearchOptions } from './search';

/** Toolbar: Dev/{GitHub, Gitea, Docs}, Café de Flore; Other: Recipes/{Crêpes}, Encoded */
async function sample() {
  const b = browser('chromium');
  const r = b.fake.roots();
  const dev = await b.fake.addFolder(r.toolbar, 'Dev');
  await b.fake.addBookmark(dev.id, 'GitHub', 'https://github.com/FulgerX2007');
  await b.fake.addBookmark(dev.id, 'Gitea', 'https://gitea.io/');
  await b.fake.addBookmark(dev.id, 'Docs', 'https://example.org/docs/start');
  await b.fake.addBookmark(r.toolbar, 'Café de Flore', 'https://cafedeflore.fr/');
  const recipes = await b.fake.addFolder(r.other, 'Recipes');
  await b.fake.addBookmark(recipes.id, 'Crêpes', 'https://food.example/crepes');
  await b.fake.addBookmark(r.other, 'Encoded', 'https://example.com/caf%C3%A9/menu');
  return createSearchIndex(await b.tree());
}

const titles = async (query: string, opts?: SearchOptions) => search(await sample(), query, opts).map((r) => r.title);

describe('normalize', () => {
  it('drops case, accents and compatibility forms', () => {
    expect(normalize('Café CRÊPES')).toBe('cafe crepes');
    expect(normalize('ﬁle')).toBe('file');
    expect(normalize('Ångström')).toBe('angstrom');
  });
});

describe('search matching', () => {
  it('finds part of a title, anywhere in it', async () => {
    expect(await titles('hub')).toEqual(['GitHub']);
    expect(await titles('git')).toEqual(['GitHub', 'Gitea']);
  });

  it('finds part of a URL', async () => {
    expect(await titles('example.org/do')).toEqual(['Docs']);
    expect(await titles('FulgerX')).toEqual(['GitHub']);
  });

  it('ignores case and accents in both directions', async () => {
    expect(await titles('CAFE')).toEqual(['Café de Flore', 'Encoded']);
    expect(await titles('crêpe')).toEqual(['Crêpes']);
    expect(await titles('crepe')).toEqual(['Crêpes']);
  });

  it('matches a percent-encoded URL with an accented query', async () => {
    const r = search(await sample(), 'café/menu');
    expect(r.map((x) => x.title)).toEqual(['Encoded']);
    expect(r[0]!.allInTitle).toBe(false);
  });

  it('keeps malformed percent-encoding searchable as is', async () => {
    const b = browser('firefox');
    await b.fake.addBookmark(b.fake.roots().toolbar, 'Broken', 'https://example.com/%E0%A4%A');
    const index = createSearchIndex(await b.tree());
    expect(search(index, '%e0%a4').map((x) => x.title)).toEqual(['Broken']);
  });

  it('matches ligatures by their letters', async () => {
    const b = browser('firefox');
    await b.fake.addBookmark(b.fake.roots().toolbar, 'Proﬁle', 'https://example.com/me');
    expect(search(createSearchIndex(await b.tree()), 'profile').map((x) => x.title)).toEqual(['Proﬁle']);
  });

  it('requires every word, each in the title or the URL', async () => {
    expect(await titles('git hub')).toEqual(['GitHub']);
    expect(await titles('docs start')).toEqual(['Docs']);
    expect(await titles('git nothing')).toEqual([]);
  });

  it('matches folders by title only', async () => {
    expect(await titles('recip')).toEqual(['Recipes']);
    // "food.example" is only in a bookmark URL inside Recipes.
    expect(await titles('food')).toEqual(['Crêpes']);
  });

  it('never returns roots', async () => {
    expect(await titles('bookmarks bar')).toEqual([]);
  });
});

describe('search results', () => {
  it('gives the folder path and the URL', async () => {
    const [crepes] = search(await sample(), 'crepes');
    expect(crepes).toMatchObject({ kind: 'bookmark', title: 'Crêpes', url: 'https://food.example/crepes', path: ['Other bookmarks', 'Recipes'], allInTitle: true });
  });

  it('ranks matches with every word in the title first, then the rest, each in tree order', async () => {
    // "io" is only in Gitea's URL, so Gitea lands in the second group.
    const r = search(await sample(), 'gitea io');
    expect(r.map((x) => [x.title, x.allInTitle])).toEqual([['Gitea', false]]);
    const mixed = search(await sample(), 'e');
    const firstUrlOnly = mixed.findIndex((x) => !x.allInTitle);
    expect(mixed.slice(0, firstUrlOnly).every((x) => x.allInTitle)).toBe(true);
    expect(mixed.slice(firstUrlOnly).every((x) => !x.allInTitle)).toBe(true);
    expect(mixed.slice(0, firstUrlOnly).map((x) => x.title)).toEqual(['Dev', 'Gitea', 'Café de Flore', 'Recipes', 'Crêpes', 'Encoded']);
    expect(mixed.slice(firstUrlOnly).map((x) => x.title)).toEqual(['GitHub', 'Docs']);
  });

  it('puts a word-in-title-and-word-in-URL match in the second group', async () => {
    const r = search(await sample(), 'docs example');
    expect(r.map((x) => [x.title, x.allInTitle])).toEqual([['Docs', false]]);
  });

  it('filters by kind and honors the limit', async () => {
    expect(await titles('e', { kinds: ['folder'] })).toEqual(['Dev', 'Recipes']);
    expect(await titles('e', { kinds: ['bookmark'], limit: 2 })).toEqual(['Gitea', 'Café de Flore']);
    expect(await titles('e', { limit: 0 })).toEqual([]);
  });

  it('returns nothing for empty or blank queries', async () => {
    expect(await titles('')).toEqual([]);
    expect(await titles('   \t ')).toEqual([]);
  });
});

describe('search performance', () => {
  it('answers a query over 10k bookmarks quickly', () => {
    const nodes = new Map<string, LocalNode>();
    const root: LocalNode = { id: 'r', parentId: '', kind: 'folder', title: 'Toolbar', children: [] };
    nodes.set('r', root);
    for (let f = 0; f < 100; f++) {
      const folder: LocalNode = { id: `f${f}`, parentId: 'r', kind: 'folder', title: `Folder ${f}`, children: [] };
      nodes.set(folder.id, folder);
      root.children!.push(folder.id);
      for (let b = 0; b < 100; b++) {
        const id = `b${f}_${b}`;
        nodes.set(id, { id, parentId: folder.id, kind: 'bookmark', title: `Bookmark ${f}-${b} café`, url: `https://site${f}.example/path/${b}?q=${f * b}` });
        folder.children!.push(id);
      }
    }
    const tree: LocalTree = { roots: { [ROOT_TOOLBAR]: 'r' }, nodes };
    const index = createSearchIndex(tree);
    search(index, 'warm up');
    const times: number[] = [];
    for (const q of ['site42.example/path/7', 'cafe 99-1', 'nomatch', 'bookmark', 'path/5']) {
      const t0 = performance.now();
      search(index, q, { limit: 50 });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[2]!).toBeLessThan(50);
  });
});
