package io.booksync.android.ui.bookmarks

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.longClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.booksync.android.core.FakeCore
import io.booksync.android.core.Position
import io.booksync.android.core.Roots
import io.booksync.android.core.Status
import io.booksync.android.ui.theme.BookSyncTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FolderScreenTest {
    @get:Rule val compose = createComposeRule()

    private val opened = mutableListOf<String>()
    private lateinit var core: FakeCore
    private lateinit var dev: String
    private lateinit var script: String

    private fun show() {
        core = FakeCore(Status(signedIn = true))
        runBlocking {
            dev = core.addFolder(Roots.TOOLBAR, Position.End, "Dev")
            core.addBookmark(dev, Position.End, "Go", "https://go.dev/")
            script = core.addBookmark(dev, Position.End, "Script", "javascript:alert(1)")
        }
        val vm = BookmarksViewModel(core)
        compose.setContent { BookSyncTheme { BookmarksScreen(vm, onOpenUrl = { opened += it }, onSignOut = {}, onLeave = {}) } }
    }

    @Test
    fun browseAndOpenOnlyWebLinks() {
        show()
        compose.onNodeWithText("Bookmarks Toolbar").performClick()
        compose.onNodeWithTag("row-$dev").performClick()
        compose.onNodeWithTag("title").assertExists()
        compose.onNodeWithText("Go").performClick()
        compose.onNodeWithText("Script").performClick()
        assertEquals(listOf("https://go.dev/"), opened)
        compose.onNodeWithText("This link cannot be opened in a browser.").assertExists()
    }

    @Test
    fun rootsHaveNoEditActions() {
        show()
        compose.onNodeWithTag("row-${Roots.TOOLBAR}").performTouchInput { longClick() }
        compose.onNodeWithTag("action-rename").assertDoesNotExist()
        compose.onNodeWithText("Bookmarks Toolbar").performClick()
        compose.onNodeWithTag("row-$dev").performTouchInput { longClick() }
        compose.onNodeWithTag("action-rename").assertExists()
    }

    @Test
    fun movePickerHidesTheFolderItselfAndAddWorks() {
        show()
        compose.onNodeWithText("Bookmarks Toolbar").performClick()
        compose.onNodeWithTag("row-$dev").performTouchInput { longClick() }
        compose.onNodeWithTag("action-move").performClick()
        compose.onNodeWithTag("target-$dev").assertDoesNotExist()
        compose.onNodeWithTag("target-${Roots.MOBILE}").performClick()
        compose.waitUntil { core.calls.any { it.startsWith("move $dev ${Roots.MOBILE}") } }

        compose.onNodeWithTag("add").performClick()
        compose.onNodeWithText("Add folder").performClick()
        compose.onNodeWithTag("field-0").performTextInput("New")
        compose.onNodeWithTag("dialogOk").performClick()
        compose.waitUntil { core.calls.any { it == "addFolder ${Roots.TOOLBAR} New" } }
        compose.onNodeWithText("New").assertExists()
    }

    @Test
    fun searchFindsAndOpens() {
        show()
        compose.onNodeWithTag("search").performClick()
        compose.onNodeWithTag("searchField").performTextInput("go.dev")
        compose.onNodeWithText("Go").performClick()
        assertTrue("https://go.dev/" in opened)
    }
}
