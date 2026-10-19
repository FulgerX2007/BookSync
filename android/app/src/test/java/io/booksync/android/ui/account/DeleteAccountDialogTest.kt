package io.booksync.android.ui.account

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.booksync.android.ui.AccountDeletion
import io.booksync.android.ui.theme.BookSyncTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DeleteAccountDialogTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun confirmNeedsUsernameAndPassword() {
        val deleted = mutableListOf<Pair<String, String>>()
        compose.setContent {
            BookSyncTheme { DeleteAccountDialog("alice", AccountDeletion(), onDelete = { u, p -> deleted += u to p }, onDismiss = {}) }
        }
        compose.onNodeWithText("alice", substring = true).assertExists()
        compose.onNodeWithTag("deleteConfirm").assertIsNotEnabled()
        compose.onNodeWithTag("deleteUsername").performTextInput("alice")
        compose.onNodeWithTag("deleteConfirm").assertIsNotEnabled()
        compose.onNodeWithTag("deletePassword").performTextInput("secret-password")
        compose.onNodeWithTag("deleteConfirm").assertIsEnabled().performClick()
        assertEquals(listOf("alice" to "secret-password"), deleted)
    }

    @Test
    fun showsErrorAndLocksWhileBusy() {
        compose.setContent {
            BookSyncTheme { DeleteAccountDialog("alice", AccountDeletion(busy = true, error = "invalid_credentials"), onDelete = { _, _ -> }, onDismiss = {}) }
        }
        compose.onNodeWithTag("deleteError").assertTextContains("incorrect", substring = true)
        compose.onNodeWithTag("deleteUsername").assertIsNotEnabled()
        compose.onNodeWithTag("deleteConfirm").assertIsNotEnabled()
    }
}
