package io.booksync.android.share

import io.booksync.android.core.CoreException
import io.booksync.android.core.FakeCore
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

class ShareViewModelTest {
    @get:Rule val main = MainDispatcherRule()

    @Test
    fun urlExtraction() {
        val cases = mapOf(
            "https://example.com/a" to "https://example.com/a",
            "  http://x.example  " to "http://x.example",
            "Look at this: https://news.example/story?id=1." to "https://news.example/story?id=1",
            "(see https://a.example/path)" to "https://a.example/path",
            "first https://one.example then https://two.example" to "https://one.example",
            "HTTPS://Upper.Example/" to "HTTPS://Upper.Example/",
            "\"https://quoted.example/x\"" to "https://quoted.example/x",
        )
        for ((text, want) in cases) assertEquals(text, want, extractUrl(text))
        for (none in listOf(null, "", "no link here", "ftp://files.example/", "javascript:alert(1)", "example.com")) {
            assertNull(none, extractUrl(none))
        }
    }

    @Test
    fun titles() {
        assertEquals("Story", shareTitle(" Story ", "https://news.example/x"))
        assertEquals("news.example", shareTitle(null, "https://www.news.example/x"))
        assertEquals("news.example", shareTitle("  ", "https://news.example/x"))
    }

    private fun vm(core: FakeCore, last: String? = null, saved: MutableList<String> = mutableListOf(), remembered: MutableList<String> = mutableListOf()) =
        ShareViewModel(core, { last }, { remembered += it }, { saved += "sync" })

    @Test
    fun savesIntoTheRememberedFolderAndSchedulesSync() {
        val core = FakeCore(Status(signedIn = true))
        val reading = runBlocking { core.addFolder(Roots.MOBILE, Position.End, "Reading") }
        val saved = mutableListOf<String>()
        val remembered = mutableListOf<String>()
        val vm = vm(core, last = reading, saved = saved, remembered = remembered)
        vm.load("Great read https://blog.example/post", "A Post", { "root:$it" })
        with(vm.state.value) {
            assertFalse(loading)
            assertEquals("https://blog.example/post", url)
            assertEquals("A Post", title)
            assertEquals(reading, folder)
            assertEquals("root:${Roots.TOOLBAR}", folders.first().title)
        }
        vm.setTitle("Renamed")
        vm.save()
        assertTrue(vm.state.value.done)
        assertEquals(listOf("sync"), saved)
        assertEquals(listOf(reading), remembered)
        assertEquals("Renamed", core.tree.children(reading).single().title)
    }

    @Test
    fun defaultsToMobileWhenTheLastFolderIsGone() {
        val core = FakeCore(Status(needsReauth = true))
        val vm = vm(core, last = "deleted")
        vm.load("https://x.example", null) { it }
        assertEquals(Roots.MOBILE, vm.state.value.folder)
        assertFalse("a revoked device can still save; it syncs after sign-in", vm.state.value.signedOut)
    }

    @Test
    fun signedOutAndNoUrl() {
        val signedOut = vm(FakeCore())
        signedOut.load("https://x.example", null) { it }
        assertTrue(signedOut.state.value.signedOut)

        val noUrl = vm(FakeCore(Status(signedIn = true)))
        noUrl.load("just text", null) { it }
        assertEquals("no_url", noUrl.state.value.error)
        assertNull(noUrl.state.value.url)
    }

    @Test
    fun saveErrorsAreShown() {
        val core = FakeCore(Status(signedIn = true))
        val saved = mutableListOf<String>()
        val vm = vm(core, saved = saved)
        vm.load("https://x.example", null) { it }
        core.failNext = CoreException("stale", "gone")
        vm.save()
        assertEquals("stale", vm.state.value.error)
        assertFalse(vm.state.value.done)
        assertTrue(saved.isEmpty())
    }
}
