package io.booksync.android.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.booksync.android.core.BookSyncCore
import io.booksync.android.core.CoreException
import io.booksync.android.core.Kit
import io.booksync.android.core.Status
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** The app's screens; small enough that a route value beats a navigation library. */
sealed interface Route {
    data object Loading : Route
    data object Welcome : Route
    data object Register : Route
    data class Login(val serverUrl: String = "", val username: String = "", val reauth: Boolean = false) : Route
    data class EmergencyKit(val kit: Kit) : Route
    data object Bookmarks : Route
}

/** Top-level state: which screen, the core status, and one-time notices. */
class AppViewModel(
    private val core: BookSyncCore,
    /** Called after the user signs in or finishes registration (starts a sync). */
    private val onSignedIn: () -> Unit = {},
) : ViewModel() {
    private val _route = MutableStateFlow<Route>(Route.Loading)
    val route: StateFlow<Route> = _route.asStateFlow()

    private val _status = MutableStateFlow(Status())
    val status: StateFlow<Status> = _status.asStateFlow()

    /** A code to show once (state_unreadable), or a failed sign-out. */
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    init {
        viewModelScope.launch {
            val s = refreshStatus()
            s.notice?.let { _notice.value = it }
            _route.value = if (s.hasAccount) Route.Bookmarks else Route.Welcome
        }
    }

    suspend fun refreshStatus(): Status = core.status().also { _status.value = it }

    fun dismissNotice() {
        _notice.value = null
    }

    fun showRegister() {
        _route.value = Route.Register
    }

    fun showLogin() {
        _route.value = Route.Login()
    }

    /** After a 401: sign in again as the same account; bookmarks are kept. */
    fun showReauth() {
        val s = _status.value
        _route.value = Route.Login(s.serverUrl.orEmpty(), s.username.orEmpty(), reauth = true)
    }

    fun back() {
        _route.value = when (val r = _route.value) {
            is Route.Login -> if (r.reauth) Route.Bookmarks else Route.Welcome
            Route.Register -> Route.Welcome
            else -> r
        }
    }

    fun registered(kit: Kit) {
        _route.value = Route.EmergencyKit(kit)
    }

    fun kitSaved() = enterApp()

    fun signedIn() = enterApp()

    private fun enterApp() {
        viewModelScope.launch {
            refreshStatus()
            _route.value = Route.Bookmarks
            onSignedIn()
        }
    }

    fun signOut() {
        viewModelScope.launch {
            try {
                core.logout()
            } catch (e: CoreException) {
                _notice.value = e.code
            }
            refreshStatus()
            _route.value = Route.Welcome
        }
    }
}
