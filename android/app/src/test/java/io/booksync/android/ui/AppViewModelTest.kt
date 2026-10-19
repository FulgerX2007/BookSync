package io.booksync.android.ui

import io.booksync.android.core.CoreException
import io.booksync.android.core.FakeCore
import io.booksync.android.core.Status
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

class AppViewModelTest {
    @get:Rule val main = MainDispatcherRule()

    @Test
    fun startsAtWelcomeOrHome() {
        assertEquals(Route.Welcome, AppViewModel(FakeCore()).route.value)
        assertEquals(Route.Bookmarks, AppViewModel(FakeCore(Status(signedIn = true))).route.value)
        assertEquals("a revoked device keeps its bookmarks", Route.Bookmarks, AppViewModel(FakeCore(Status(needsReauth = true))).route.value)
    }

    @Test
    fun registrationFlow() {
        val core = FakeCore()
        var signedIn = 0
        val app = AppViewModel(core, onSignedIn = { signedIn++ })
        app.showRegister()
        assertEquals(Route.Register, app.route.value)
        app.back()
        assertEquals(Route.Welcome, app.route.value)
        app.registered(core.kit)
        assertEquals(Route.EmergencyKit(core.kit), app.route.value)
        app.kitSaved()
        assertEquals(Route.Bookmarks, app.route.value)
        assertEquals(1, signedIn)
    }

    @Test
    fun reauthPrefillsAndReturnsHome() {
        val app = AppViewModel(FakeCore(Status(needsReauth = true, serverUrl = "https://s", username = "alice")))
        app.showReauth()
        assertEquals(Route.Login("https://s", "alice", reauth = true), app.route.value)
        app.back()
        assertEquals(Route.Bookmarks, app.route.value)
        app.showLogin()
        assertEquals(Route.Login(), app.route.value)
    }

    @Test
    fun signOutAndNotices() {
        val core = FakeCore(Status(signedIn = true, notice = "state_unreadable"))
        val app = AppViewModel(core)
        assertEquals("state_unreadable", app.notice.value)
        app.dismissNotice()
        assertNull(app.notice.value)
        core.failNext = CoreException("network", "offline")
        app.signOut()
        assertEquals(Route.Welcome, app.route.value)
        assertEquals("network", app.notice.value)
    }

    @Test
    fun deleteAccountKeepsDialogOnErrorAndLeavesOnSuccess() {
        val core = FakeCore(Status(signedIn = true, serverUrl = "https://s", username = "alice"))
        var signedOut = 0
        val app = AppViewModel(core, onSignedOut = { signedOut++ })
        app.showDeleteAccount()
        assertEquals(AccountDeletion(), app.deletion.value)

        app.deleteAccount("bob", "secret-password")
        assertEquals(AccountDeletion(error = "username_mismatch"), app.deletion.value)
        assertEquals(Route.Bookmarks, app.route.value)

        core.failNext = CoreException("invalid_credentials", "wrong password")
        app.deleteAccount("alice", "wrong")
        assertEquals(AccountDeletion(error = "invalid_credentials"), app.deletion.value)
        assertEquals(0, signedOut)

        app.deleteAccount("alice", "secret-password")
        assertNull(app.deletion.value)
        assertEquals(Route.Welcome, app.route.value)
        assertEquals(Status(), app.status.value)
        assertEquals(1, signedOut)
    }

    @Test
    fun cancelDeleteAccount() {
        val app = AppViewModel(FakeCore(Status(signedIn = true, username = "alice")))
        app.showDeleteAccount()
        app.cancelDeleteAccount()
        assertNull(app.deletion.value)
    }
}
