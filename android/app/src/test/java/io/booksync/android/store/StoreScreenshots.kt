package io.booksync.android.store

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.booksync.android.core.FakeCore
import io.booksync.android.core.Position
import io.booksync.android.core.Roots
import io.booksync.android.core.Status
import io.booksync.android.share.ShareSheet
import io.booksync.android.share.ShareViewModel
import io.booksync.android.sync.SyncUi
import io.booksync.android.ui.auth.WelcomeScreen
import io.booksync.android.ui.bookmarks.BookmarksScreen
import io.booksync.android.ui.bookmarks.BookmarksViewModel
import io.booksync.android.ui.sync.SyncStatusBar
import io.booksync.android.ui.theme.BookSyncTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Google Play phone screenshots (1080×1920), rendered from the real screens over
 * FakeCore with sample bookmarks. Skipped unless BOOKSYNC_STORE_SHOTS names the
 * output directory; `make android-store-shots` sets it to android/store/screenshots.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w360dp-h640dp-xxhdpi")
class StoreScreenshots {
    @get:Rule val compose = createComposeRule()

    private val out = System.getenv("BOOKSYNC_STORE_SHOTS")?.let(::File)
    private lateinit var core: FakeCore
    private lateinit var work: String

    @Before
    fun sampleBookmarks() {
        assumeTrue("BOOKSYNC_STORE_SHOTS is not set", out != null)
        core = FakeCore(Status(signedIn = true, serverUrl = "https://bookmarks.example.com", username = "alex"))
        runBlocking {
            work = core.addFolder(Roots.TOOLBAR, Position.End, "Work")
            val reading = core.addFolder(Roots.TOOLBAR, Position.End, "Reading")
            core.addFolder(Roots.TOOLBAR, Position.End, "Travel")
            core.addBookmark(Roots.TOOLBAR, Position.End, "GitHub", "https://github.com/")
            core.addBookmark(Roots.TOOLBAR, Position.End, "Go documentation", "https://go.dev/doc/")
            core.addBookmark(work, Position.End, "Team calendar", "https://calendar.example.com/team")
            core.addBookmark(work, Position.End, "Design docs", "https://docs.example.com/design")
            core.addBookmark(work, Position.End, "Release checklist", "https://wiki.example.com/release")
            core.addBookmark(work, Position.End, "Go documentation", "https://go.dev/doc/")
            core.addBookmark(work, Position.End, "Kotlin language guide", "https://kotlinlang.org/docs/home.html")
            core.addBookmark(work, Position.End, "Android developers", "https://developer.android.com/")
            core.addBookmark(reading, Position.End, "Effective Go", "https://go.dev/doc/effective_go")
            core.addBookmark(reading, Position.End, "The Go Blog", "https://go.dev/blog/")
            core.addBookmark(Roots.MOBILE, Position.End, "Weather", "https://weather.example.com/")
            core.addBookmark(Roots.OTHER, Position.End, "Recipes", "https://recipes.example.com/")
        }
    }

    private fun save(name: String) {
        compose.waitForIdle()
        val dir = out!!.apply { mkdirs() }
        File(dir, name).outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    @Composable
    private fun Browser(vm: BookmarksViewModel) {
        val now = System.currentTimeMillis()
        BookmarksScreen(
            vm = vm,
            onOpenUrl = {},
            onSignOut = {},
            onLeave = {},
            banner = { SyncStatusBar(SyncUi(lastOkAt = now - 60_000), now, onSignIn = {}, onReview = {}) },
        )
    }

    @Test
    fun shots() {
        val vm = BookmarksViewModel(core)
        compose.setContent { BookSyncTheme(dark = false) { Browser(vm) } }
        save("1-folders.png")

        compose.onNodeWithText("Bookmarks Toolbar").performClick()
        compose.onNodeWithTag("row-$work").performClick()
        save("2-folder.png")

        compose.onNodeWithTag("search").performClick()
        compose.onNodeWithTag("searchField").performTextInput("go")
        save("3-search.png")
    }

    @Test
    fun share() {
        val vm = ShareViewModel(core, lastFolder = { work }, rememberFolder = {}, onSaved = {})
        vm.load("https://go.dev/blog/", "The Go Blog", rootTitle = { mapOf(Roots.TOOLBAR to "Bookmarks Toolbar", Roots.MENU to "Bookmarks Menu", Roots.OTHER to "Other Bookmarks", Roots.MOBILE to "Mobile Bookmarks")[it] ?: it })
        compose.setContent {
            BookSyncTheme(dark = false) {
                Box(Modifier.fillMaxSize().background(Color(0xFF3C4253)).padding(16.dp), contentAlignment = Alignment.Center) {
                    ShareSheet(vm, onClose = {}, onOpenApp = {})
                }
            }
        }
        save("4-share.png")
    }

    @Test
    fun welcome() {
        compose.setContent { BookSyncTheme(dark = false) { WelcomeScreen(onCreate = {}, onSignIn = {}) } }
        save("5-welcome.png")
    }
}
