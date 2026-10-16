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
        val app = AppViewModel(core)
        var signedIn = 0
        app.onSignedIn = { signedIn++ }
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
}
