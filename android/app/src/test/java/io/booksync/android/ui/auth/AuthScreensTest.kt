package io.booksync.android.ui.auth

import androidx.compose.material3.Text
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.booksync.android.core.FakeCore
import io.booksync.android.core.Kit
import io.booksync.android.core.Status
import io.booksync.android.ui.BookSyncApp
import io.booksync.android.ui.theme.BookSyncTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AuthScreensTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun kitContinueIsGatedOnSaved() {
        var continued = 0
        compose.setContent {
            BookSyncTheme { EmergencyKitScreen(Kit("text", "BS1-AAAA", "kit.txt")) { continued++ } }
        }
        compose.onNodeWithTag("kitSyncId").assertTextContains("BS1-AAAA")
        compose.onNodeWithTag("kitContinue").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("kitSaved").performScrollTo().performClick()
        compose.onNodeWithTag("kitContinue").performScrollTo().assertIsEnabled().performClick()
        assertEquals(1, continued)
    }

    @Test
    fun loginValidatesSyncIdLive() {
        val core = FakeCore()
        val vm = AuthViewModel(core)
        compose.setContent {
            BookSyncTheme {
                val form by vm.form.collectAsState()
                LoginScreen(form, vm, reauth = false, onBack = {}, onSignedIn = {})
            }
        }
        compose.onNodeWithTag("server").performTextInput("https://sync.example")
        compose.onNodeWithTag("username").performTextInput("alice")
        compose.onNodeWithTag("password").performTextInput("secret")
        compose.onNodeWithTag("syncId").performTextInput("A".repeat(26) + "ZZ")
        compose.onNodeWithText("This SyncID has a typo.").assertExists()
        compose.onNodeWithTag("submit").performScrollTo().assertIsNotEnabled()
    }

    @Test
    fun welcomeToSignInToHome() {
        val core = FakeCore()
        compose.setContent { BookSyncApp(core) { Text("HOME") } }
        compose.onNodeWithText("Sign in").performClick()
        compose.onNodeWithTag("server").performTextInput("https://sync.example")
        compose.onNodeWithTag("username").performTextInput("alice")
        compose.onNodeWithTag("password").performTextInput("secret")
        compose.onNodeWithTag("syncId").performTextInput("A".repeat(28))
        compose.onNodeWithTag("submit").performScrollTo().assertIsEnabled().performClick()
        compose.waitUntil { core.status == Status(signedIn = true, serverUrl = "https://sync.example", username = "alice") }
        compose.onNodeWithText("HOME").assertExists()
    }
}
