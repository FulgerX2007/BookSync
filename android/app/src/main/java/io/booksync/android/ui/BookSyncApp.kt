package io.booksync.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.booksync.android.R
import io.booksync.android.core.BookSyncCore
import io.booksync.android.ui.auth.AuthViewModel
import io.booksync.android.ui.auth.EmergencyKitScreen
import io.booksync.android.ui.auth.LoginScreen
import io.booksync.android.ui.auth.RegisterScreen
import io.booksync.android.ui.auth.WelcomeScreen
import io.booksync.android.ui.common.messageFor
import io.booksync.android.ui.theme.BookSyncTheme

/** The whole app UI over one core. Home is provided by the caller (the bookmark browser). */
@Composable
fun BookSyncApp(
    core: BookSyncCore,
    onSignedIn: () -> Unit = {},
    onSignedOut: () -> Unit = {},
    app: AppViewModel = viewModel(factory = viewModelFactory { initializer { AppViewModel(core, onSignedIn, onSignedOut) } }),
    home: @Composable (AppViewModel) -> Unit,
) {
    BookSyncTheme {
        val route by app.route.collectAsStateWithLifecycle()
        val notice by app.notice.collectAsStateWithLifecycle()

        when (val r = route) {
            Route.Loading -> Unit
            Route.Welcome -> WelcomeScreen(onCreate = app::showRegister, onSignIn = app::showLogin)
            Route.Register, is Route.Login -> {
                // A fresh form per visit: secrets never outlive the screen.
                val auth: AuthViewModel = viewModel(key = r.toString(), factory = viewModelFactory { initializer { AuthViewModel(core) } })
                val form by auth.form.collectAsStateWithLifecycle()
                BackHandler(onBack = app::back)
                if (r is Route.Login) {
                    LaunchedEffect(r) { auth.prefill(r.serverUrl, r.username) }
                    LoginScreen(form, auth, r.reauth, onBack = app::back, onSignedIn = app::signedIn)
                } else {
                    RegisterScreen(form, auth, onBack = app::back, onRegistered = app::registered)
                }
            }
            is Route.EmergencyKit -> EmergencyKitScreen(r.kit, onContinue = app::kitSaved)
            Route.Bookmarks -> home(app)
        }

        notice?.let { code ->
            AlertDialog(
                onDismissRequest = app::dismissNotice,
                confirmButton = { TextButton(onClick = app::dismissNotice) { Text(stringResource(R.string.ok)) } },
                text = { Text(stringResource(messageFor(code))) },
            )
        }
    }
}

/** Asks before signing out, which removes this device's bookmarks. */
@Composable
fun SignOutDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.sign_out_title)) },
        text = { Text(stringResource(R.string.sign_out_message)) },
        confirmButton = { TextButton(onClick = onConfirm) { Text(stringResource(R.string.sign_out)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}
