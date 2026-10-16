package io.booksync.android.search

import io.booksync.android.core.NodeKind
import io.booksync.android.core.Roots
import io.booksync.android.core.Tree
import io.booksync.android.core.VNode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Ported from extension/src/bookmarks/search.test.ts. */
class BookmarkSearchTest {
    private class Builder {
        val nodes = Roots.ALL.associateWith { VNode(it, NodeKind.FOLDER, it, children = emptyList()) }.toMutableMap()
        private var next = 0

        private fun add(parent: String, n: VNode): String {
            nodes[n.guid] = n
            val p = nodes.getValue(parent)
            nodes[parent] = p.copy(children = p.children.orEmpty() + n.guid)
            return n.guid
        }

        fun folder(parent: String, title: String) = add(parent, VNode("f${next++}", NodeKind.FOLDER, title, children = emptyList()))
        fun bookmark(parent: String, title: String, url: String) = add(parent, VNode("b${next++}", NodeKind.BOOKMARK, title, url = url))
        fun tree() = Tree(1, 0, "", 0.0, nodes.toMap())
    }

    private val rootTitles = mapOf(Roots.TOOLBAR to "Bookmarks bar", Roots.OTHER to "Other bookmarks", Roots.MENU to "Menu", Roots.MOBILE to "Mobile")

    /** Toolbar: Dev/{GitHub, Gitea, Docs}, Café de Flore; Other: Recipes/{Crêpes}, Encoded */
    private fun sample(): BookmarkSearch {
        val b = Builder()
        val dev = b.folder(Roots.TOOLBAR, "Dev")
        b.bookmark(dev, "GitHub", "https://github.com/FulgerX2007")
        b.bookmark(dev, "Gitea", "https://gitea.io/")
        b.bookmark(dev, "Docs", "https://example.org/docs/start")
        b.bookmark(Roots.TOOLBAR, "Café de Flore", "https://cafedeflore.fr/")
        val recipes = b.folder(Roots.OTHER, "Recipes")
        b.bookmark(recipes, "Crêpes", "https://food.example/crepes")
        b.bookmark(Roots.OTHER, "Encoded", "https://example.com/caf%C3%A9/menu")
        return BookmarkSearch(b.tree()) { rootTitles.getValue(it) }
    }

    private fun titles(q: String, limit: Int = Int.MAX_VALUE, kinds: Set<NodeKind> = NodeKind.entries.toSet()) =
        sample().search(q, limit, kinds).map { it.title }

    @Test
    fun normalize() {
        assertEquals("cafe crepes", BookmarkSearch.normalize("Café CRÊPES"))
        assertEquals("file", BookmarkSearch.normalize("ﬁle"))
        assertEquals("angstrom", BookmarkSearch.normalize("Ångström"))
    }

    @Test
    fun findsPartOfTitleOrUrl() {
        assertEquals(listOf("GitHub"), titles("hub"))
        assertEquals(listOf("GitHub", "Gitea"), titles("git"))
        assertEquals(listOf("Docs"), titles("example.org/do"))
        assertEquals(listOf("GitHub"), titles("FulgerX"))
    }

    @Test
    fun ignoresCaseAndAccentsBothWays() {
        assertEquals(listOf("Café de Flore", "Encoded"), titles("CAFE"))
        assertEquals(listOf("Crêpes"), titles("crêpe"))
        assertEquals(listOf("Crêpes"), titles("crepe"))
    }

    @Test
    fun percentEncodedUrls() {
        val r = sample().search("café/menu")
        assertEquals(listOf("Encoded"), r.map { it.title })
        assertFalse(r[0].allInTitle)

        val b = Builder()
        b.bookmark(Roots.TOOLBAR, "Broken", "https://example.com/%E0%A4%A")
        assertEquals(listOf("Broken"), BookmarkSearch(b.tree()).search("%e0%a4").map { it.title })
    }

    @Test
    fun decodeUriMatchesJavaScript() {
        assertEquals("https://x/café/a b", BookmarkSearch.decodeUri("https://x/caf%C3%A9/a%20b"))
        assertEquals("reserved stay encoded", "a%2Fb%3Fc%23d%26e", BookmarkSearch.decodeUri("a%2Fb%3Fc%23d%26e"))
        assertEquals("x%E0%A4%A", BookmarkSearch.decodeUri("x%E0%A4%A"))
        assertEquals("x%ZZ", BookmarkSearch.decodeUri("x%ZZ"))
        assertEquals("x%", BookmarkSearch.decodeUri("x%"))
        assertEquals("%C3", BookmarkSearch.decodeUri("%C3"))
        assertEquals("%FF%FF", BookmarkSearch.decodeUri("%FF%FF"))
        assertEquals("😀", BookmarkSearch.decodeUri("%F0%9F%98%80"))
    }

    @Test
    fun ligatures() {
        val b = Builder()
        b.bookmark(Roots.TOOLBAR, "Proﬁle", "https://example.com/me")
        assertEquals(listOf("Proﬁle"), BookmarkSearch(b.tree()).search("profile").map { it.title })
    }

    @Test
    fun everyWordInTitleOrUrl() {
        assertEquals(listOf("GitHub"), titles("git hub"))
        assertEquals(listOf("Docs"), titles("docs start"))
        assertEquals(emptyList<String>(), titles("git nothing"))
    }

    @Test
    fun foldersByTitleOnlyAndNeverRoots() {
        assertEquals(listOf("Recipes"), titles("recip"))
        assertEquals(listOf("Crêpes"), titles("food"))
        assertEquals(emptyList<String>(), titles("toolbar"))
    }

    @Test
    fun resultsCarryPathAndUrl() {
        val crepes = sample().search("crepes").single()
        assertEquals(SearchResult(crepes.guid, NodeKind.BOOKMARK, "Crêpes", "https://food.example/crepes", listOf("Other bookmarks", "Recipes"), true), crepes)
    }

    @Test
    fun ranking() {
        assertEquals(listOf("Gitea" to false), sample().search("gitea io").map { it.title to it.allInTitle })
        val mixed = sample().search("e")
        val firstUrlOnly = mixed.indexOfFirst { !it.allInTitle }
        assertTrue(mixed.take(firstUrlOnly).all { it.allInTitle })
        assertTrue(mixed.drop(firstUrlOnly).none { it.allInTitle })
        assertEquals(listOf("Dev", "Gitea", "Café de Flore", "Recipes", "Crêpes", "Encoded"), mixed.take(firstUrlOnly).map { it.title })
        assertEquals(listOf("GitHub", "Docs"), mixed.drop(firstUrlOnly).map { it.title })
        assertEquals(listOf("Docs" to false), sample().search("docs example").map { it.title to it.allInTitle })
    }

    @Test
    fun kindsAndLimit() {
        assertEquals(listOf("Dev", "Recipes"), titles("e", kinds = setOf(NodeKind.FOLDER)))
        assertEquals(listOf("Gitea", "Café de Flore"), titles("e", limit = 2, kinds = setOf(NodeKind.BOOKMARK)))
        assertEquals(emptyList<String>(), titles("e", limit = 0))
        assertEquals(emptyList<String>(), titles(""))
        assertEquals(emptyList<String>(), titles("   \t "))
    }

    @Test
    fun fastOverTenThousandBookmarks() {
        val b = Builder()
        repeat(100) { f ->
            val folder = b.folder(Roots.TOOLBAR, "Folder $f")
            repeat(100) { i -> b.bookmark(folder, "Bookmark $f-$i café", "https://site$f.example/path/$i?q=${f * i}") }
        }
        val index = BookmarkSearch(b.tree())
        index.search("warm up")
        val times = listOf("site42.example/path/7", "cafe 99-1", "nomatch", "bookmark", "path/5").map { q ->
            val t0 = System.nanoTime()
            index.search(q, limit = 50)
            (System.nanoTime() - t0) / 1_000_000.0
        }.sorted()
        assertTrue("median ${times[2]} ms", times[2] < 50)
    }
}
