package io.booksync.android

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.net.toUri
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.booksync.android.ui.BookSyncApp
import io.booksync.android.ui.SignOutDialog
import io.booksync.android.ui.bookmarks.BookmarksScreen
import io.booksync.android.ui.bookmarks.BookmarksViewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val core = (application as BookSyncApplication).core
        setContent {
            BookSyncApp(core) { app ->
                val browser: BookmarksViewModel = viewModel(factory = viewModelFactory { initializer { BookmarksViewModel(core) } })
                var confirmSignOut by remember { mutableStateOf(false) }
                BookmarksScreen(
                    vm = browser,
                    onOpenUrl = ::openInBrowser,
                    onSignOut = { confirmSignOut = true },
                    onLeave = ::finish,
                )
                if (confirmSignOut) {
                    SignOutDialog(
                        onConfirm = {
                            confirmSignOut = false
                            app.signOut()
                        },
                        onDismiss = { confirmSignOut = false },
                    )
                }
            }
        }
    }

    /** Hands a web link to the user's browser of choice. */
    private fun openInBrowser(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            // No browser installed: nothing sensible to do.
        }
    }
}
