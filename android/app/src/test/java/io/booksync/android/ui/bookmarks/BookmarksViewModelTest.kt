package io.booksync.android.ui.bookmarks

import io.booksync.android.core.CoreException
import io.booksync.android.core.FakeCore
import io.booksync.android.core.NodeKind
import io.booksync.android.core.Position
import io.booksync.android.core.Roots
import io.booksync.android.core.Status
import io.booksync.android.ui.MainDispatcherRule
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class BookmarksViewModelTest {
    @get:Rule val main = MainDispatcherRule()

    /** Toolbar: Dev/{Go (https), Script (javascript:)}, News */
    private fun setup(): Triple<FakeCore, BookmarksViewModel, MutableList<Int>> = runBlocking {
        val core = FakeCore(Status(signedIn = true))
        val dev = core.addFolder(Roots.TOOLBAR, Position.End, "Dev")
        core.addBookmark(dev, Position.End, "Go", "https://go.dev/")
        core.addBookmark(dev, Position.End, "Script", "javascript:alert(1)")
        core.addBookmark(Roots.TOOLBAR, Position.End, "News", "https://news.example/")
        core.calls.clear()
        val edits = mutableListOf<Int>()
        Triple(core, BookmarksViewModel(core) { edits += 1 }, edits)
    }

    @Test
    fun navigationStack() {
        val (_, vm, _) = setup()
        assertNull(vm.state.value.folder)
        vm.open(Roots.TOOLBAR)
        assertEquals(listOf("Dev", "News"), vm.state.value.items.map { it.title })
        val dev = vm.state.value.items.first().guid
        vm.open(dev)
        assertEquals(listOf(Roots.TOOLBAR, dev), vm.state.value.path.map { it.guid })
        assertTrue(vm.up())
        assertEquals(Roots.TOOLBAR, vm.state.value.folder)
        assertTrue(vm.up())
        assertNull(vm.state.value.folder)
        assertFalse("at the roots, back leaves the screen", vm.up())
    }

    @Test
    fun editsGoThroughCoreThenRefresh() {
        val (core, vm, edits) = setup()
        vm.addFolder(Roots.MOBILE, "  Reading ")
        vm.addBookmark(Roots.MOBILE, "", "https://a.example/")
        vm.open(Roots.MOBILE)
        assertEquals(listOf("Reading", "https://a.example/"), vm.state.value.items.map { it.title })
        val reading = vm.state.value.items.first()
        vm.rename(reading.guid, "Later")
        val bm = vm.state.value.items[1]
        vm.setUrl(bm.guid, "https://b.example/")
        vm.move(bm.guid, reading.guid)
        assertEquals(listOf("Later"), vm.state.value.items.map { it.title })
        vm.requestDelete(vm.state.value.items.first())
        val confirm = vm.state.value.dialog as BrowserDialog.ConfirmDelete
        assertEquals(1, confirm.bookmarks)
        vm.delete(confirm.node.guid)
        assertTrue(vm.state.value.items.isEmpty())
        assertNull(vm.state.value.dialog)
        assertEquals(6, edits.size)
        assertEquals(6, core.calls.count { it.startsWith("add") || it.startsWith("rename") || it.startsWith("setUrl") || it.startsWith("move") || it.startsWith("delete") })
    }

    @Test
    fun coreErrorsBecomeMessages() {
        val (core, vm, edits) = setup()
        vm.show(BrowserDialog.AddBookmark(Roots.TOOLBAR))
        vm.addBookmark(Roots.TOOLBAR, "x", "not a url")
        assertEquals("invalid_url", vm.state.value.message)
        assertTrue("the dialog stays open to fix the URL", vm.state.value.dialog is BrowserDialog.AddBookmark)
        vm.dismissMessage()
        core.failNext = CoreException("stale", "gone")
        vm.rename("g0", "y")
        assertEquals("stale", vm.state.value.message)
        assertNull(vm.state.value.dialog)
        assertTrue(edits.isEmpty())
    }

    @Test
    fun onlyWebUrlsOpen() {
        val (_, vm, _) = setup()
        assertEquals("https://go.dev/", vm.urlToOpen("https://go.dev/"))
        assertEquals("HTTP://X.example/", vm.urlToOpen("HTTP://X.example/"))
        assertNull(vm.urlToOpen("javascript:alert(1)"))
        assertEquals("cannot_open", vm.state.value.message)
        assertNull(vm.urlToOpen("file:///etc/passwd"))
        assertNull(vm.urlToOpen(null))
        assertEquals("go.dev", BookmarksViewModel.displayHost("https://www.go.dev/x"))
        assertEquals("", BookmarksViewModel.displayHost(null))
    }

    @Test
    fun searchAndResults() {
        val (_, vm, _) = setup()
        vm.startSearch()
        vm.setQuery("go")
        val r = vm.state.value.results
        assertEquals(listOf("Go"), r.map { it.title })
        assertEquals("https://go.dev/", vm.openResult(r.single()))
        vm.setQuery("dev")
        val folder = vm.state.value.results.first { it.kind == NodeKind.FOLDER }
        assertNull(vm.openResult(folder))
        assertEquals(folder.guid, vm.state.value.folder)
        assertFalse(vm.state.value.searching)
        vm.startSearch()
        assertTrue("back closes the search first", vm.up())
        assertFalse(vm.state.value.searching)
    }

    @Test
    fun rootsHaveNoActionsAndMoveTargetsExcludeSubtree() {
        val (_, vm, _) = setup()
        vm.showActions(vm.state.value.tree!!.node(Roots.TOOLBAR)!!)
        assertNull(vm.state.value.dialog)
        vm.open(Roots.TOOLBAR)
        val dev = vm.state.value.items.first()
        vm.showActions(dev)
        assertEquals(BrowserDialog.Actions(dev), vm.state.value.dialog)
        val targets = vm.moveTargets(dev).map { it.guid }
        assertFalse(dev.guid in targets)
        assertEquals(Roots.ALL, targets)
        val news = vm.state.value.items[1]
        assertTrue(dev.guid in vm.moveTargets(news).map { it.guid })
    }

    @Test
    fun refreshFallsBackWhenTheOpenFolderVanished() {
        val (core, vm, _) = setup()
        vm.open(Roots.TOOLBAR)
        val dev = vm.state.value.items.first().guid
        vm.open(dev)
        runBlocking { core.delete(dev) }
        vm.refresh()
        assertNull(vm.state.value.folder)
    }
}
