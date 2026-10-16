package io.booksync.android.ui.sync

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.booksync.android.core.Pending
import io.booksync.android.sync.Blocked
import io.booksync.android.sync.SyncUi
import io.booksync.android.ui.theme.BookSyncTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SyncViewsTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun barOffersSignInAfterRevocation() {
        var signIn = 0
        compose.setContent { BookSyncTheme { SyncStatusBar(SyncUi(blocked = Blocked.Reauth), 0, onSignIn = { signIn++ }, onReview = {}) } }
        compose.onNodeWithText("The server signed this device out.").assertExists()
        compose.onNodeWithTag("syncAction").performClick()
        assertEquals(1, signIn)
    }

    @Test
    fun barStates() {
        var ui by androidx.compose.runtime.mutableStateOf(SyncUi(running = true))
        compose.setContent { BookSyncTheme { SyncStatusBar(ui, 1_000_000, onSignIn = {}, onReview = {}) } }
        compose.onNodeWithText("Syncing…").assertExists()
        ui = SyncUi(error = "network")
        compose.onNodeWithText("Offline. Will sync when the server is reachable.").assertExists()
        ui = SyncUi(blocked = Blocked.Confirm(Pending(1, 20, 0)))
        compose.onNodeWithText("Sync is paused until you decide.").assertExists()
        ui = SyncUi()
        compose.onNodeWithTag("syncBar").assertDoesNotExist()
    }

    @Test
    fun rollbackChoicesAreExplicit() {
        val picked = mutableListOf<String>()
        compose.setContent { BookSyncTheme { RollbackDialog({ picked += "local" }, { picked += "remote" }, { picked += "later" }) } }
        compose.onNodeWithTag("useLocal").performClick()
        compose.onNodeWithTag("acceptRemote").performClick()
        compose.onNodeWithText("Later").performClick()
        assertEquals(listOf("local", "remote", "later"), picked)
    }

    @Test
    fun massDeletionShowsBothDirections() {
        var confirmed = 0
        compose.setContent { BookSyncTheme { MassDeletionDialog(Pending(3, 25, 4), onConfirm = { confirmed++ }, onLater = {}) } }
        compose.onNodeWithText("This sync would delete 25 bookmarks on this device and 4 on the server.").assertExists()
        compose.onNodeWithTag("confirmDeletions").performClick()
        assertEquals(1, confirmed)
    }
}

private operator fun <T> androidx.compose.runtime.MutableState<T>.getValue(thisObj: Any?, property: kotlin.reflect.KProperty<*>): T = value
private operator fun <T> androidx.compose.runtime.MutableState<T>.setValue(thisObj: Any?, property: kotlin.reflect.KProperty<*>, v: T) {
    value = v
}
