package io.booksync.android

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.booksync.android.core.BookSyncCore
import io.booksync.android.core.Recovery
import io.booksync.android.sync.Blocked
import io.booksync.android.sync.SyncController
import io.booksync.android.ui.AppViewModel
import io.booksync.android.ui.BookSyncApp
import io.booksync.android.ui.SignOutDialog
import io.booksync.android.ui.account.DeleteAccountDialog
import io.booksync.android.ui.bookmarks.BookmarksScreen
import io.booksync.android.ui.bookmarks.BookmarksViewModel
import io.booksync.android.ui.sync.MassDeletionDialog
import io.booksync.android.ui.sync.RollbackDialog
import io.booksync.android.ui.sync.SyncStatusBar

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val booksync = application as BookSyncApplication
        setContent {
            BookSyncApp(booksync.core, onSignedIn = booksync.sync::signedIn, onSignedOut = booksync.sync::reset) { app ->
                Home(booksync.core, booksync.sync, app, ::openInBrowser, ::finish)
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

/** The signed-in home: the bookmark browser with sync status, prompts and pull-to-refresh. */
@Composable
fun Home(core: BookSyncCore, sync: SyncController, app: AppViewModel, onOpenUrl: (String) -> Unit, onLeave: () -> Unit) {
    val browser: BookmarksViewModel = viewModel(factory = viewModelFactory { initializer { BookmarksViewModel(core, sync::onEdited) } })
    val ui by sync.ui.collectAsStateWithLifecycle()
    val deletion by app.deletion.collectAsStateWithLifecycle()
    val status by app.status.collectAsStateWithLifecycle()
    var confirmSignOut by remember { mutableStateOf(false) }
    var promptHidden by remember { mutableStateOf(false) }

    LaunchedEffect(ui.treeRevision) { browser.refresh() }
    LaunchedEffect(ui.blocked) { promptHidden = false }

    BookmarksScreen(
        vm = browser,
        onOpenUrl = onOpenUrl,
        onSignOut = { confirmSignOut = true },
        onLeave = onLeave,
        onDeleteAccount = app::showDeleteAccount,
        refreshing = ui.running,
        onRefresh = sync::refresh,
        banner = { SyncStatusBar(ui, System.currentTimeMillis(), onSignIn = app::showReauth, onReview = { promptHidden = false }) },
    )

    when (val b = ui.blocked) {
        is Blocked.Rollback -> if (!promptHidden) {
            RollbackDialog(
                onUseLocal = { sync.resolveRollback(Recovery.USE_LOCAL) },
                onAcceptRemote = { sync.resolveRollback(Recovery.ACCEPT_REMOTE) },
                onLater = { promptHidden = true },
            )
        }
        is Blocked.Confirm -> if (!promptHidden) {
            MassDeletionDialog(b.pending, onConfirm = sync::confirmDeletions, onLater = { promptHidden = true })
        }
        Blocked.Reauth, null -> Unit
    }

    if (confirmSignOut) {
        SignOutDialog(
            onConfirm = {
                confirmSignOut = false
                app.signOut()
            },
            onDismiss = { confirmSignOut = false },
        )
    }

    deletion?.let { DeleteAccountDialog(status.username.orEmpty(), it, onDelete = app::deleteAccount, onDismiss = app::cancelDeleteAccount) }
}
