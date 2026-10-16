package io.booksync.android.ui.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.booksync.android.core.BookSyncCore
import io.booksync.android.core.CoreException
import io.booksync.android.core.Kit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

const val MIN_PASSWORD_LENGTH = 10
private const val SYNC_ID_CHARS = 28

data class AuthForm(
    val serverUrl: String = "",
    val username: String = "",
    val password: String = "",
    val confirm: String = "",
    val syncId: String = "",
    /** Error code for the SyncID field, shown once all 28 characters are typed. */
    val syncIdError: String? = null,
    val busy: Boolean = false,
    /** Error code from the last attempt. */
    val error: String? = null,
) {
    private val passwordLength get() = password.codePointCount(0, password.length)
    val passwordTooShort get() = password.isNotEmpty() && passwordLength < MIN_PASSWORD_LENGTH
    val confirmMismatch get() = confirm.isNotEmpty() && confirm != password

    val canRegister get() =
        !busy && serverUrl.isNotBlank() && username.isNotBlank() && passwordLength >= MIN_PASSWORD_LENGTH && confirm == password

    val canLogin get() =
        !busy && serverUrl.isNotBlank() && username.isNotBlank() && password.isNotEmpty() && syncIdComplete(syncId) && syncIdError == null
}

/** Characters of the SyncID body typed so far (prefix, dashes and spaces ignored). */
fun syncIdComplete(text: String): Boolean =
    text.uppercase().filter { it.isLetterOrDigit() }.removePrefix("BS1").length >= SYNC_ID_CHARS

/** Register and sign-in forms. Secrets live only in this state and go straight to the core. */
class AuthViewModel(private val core: BookSyncCore) : ViewModel() {
    private val _form = MutableStateFlow(AuthForm())
    val form: StateFlow<AuthForm> = _form.asStateFlow()

    fun prefill(serverUrl: String, username: String) {
        _form.update { it.copy(serverUrl = serverUrl.ifEmpty { it.serverUrl }, username = username.ifEmpty { it.username }) }
    }

    fun setServerUrl(v: String) = _form.update { it.copy(serverUrl = v, error = null) }
    fun setUsername(v: String) = _form.update { it.copy(username = v, error = null) }
    fun setPassword(v: String) = _form.update { it.copy(password = v, error = null) }
    fun setConfirm(v: String) = _form.update { it.copy(confirm = v, error = null) }

    /** Validates live, so a typo is caught before a login round trip. */
    fun setSyncId(v: String) {
        val error = if (!syncIdComplete(v)) {
            null
        } else {
            try {
                core.parseSyncId(v)
                null
            } catch (e: CoreException) {
                e.code
            }
        }
        _form.update { it.copy(syncId = v, syncIdError = error, error = null) }
    }

    fun register(onDone: (Kit) -> Unit) = submit { f ->
        val kit = core.register(f.serverUrl.trim(), f.username, f.password)
        clearSecrets()
        onDone(kit)
    }

    fun login(onDone: () -> Unit) = submit { f ->
        core.login(f.serverUrl.trim(), f.username, f.password, f.syncId)
        clearSecrets()
        onDone()
    }

    private fun clearSecrets() = _form.update { it.copy(password = "", confirm = "", syncId = "", busy = false) }

    private fun submit(action: suspend (AuthForm) -> Unit) {
        val f = _form.value
        if (f.busy) return
        _form.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                action(f)
            } catch (e: CoreException) {
                _form.update { it.copy(busy = false, error = e.code) }
            }
        }
    }
}
