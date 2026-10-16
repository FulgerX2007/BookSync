package io.booksync.android.ui.sync

import android.text.format.DateUtils
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.booksync.android.R
import io.booksync.android.core.Pending
import io.booksync.android.sync.Blocked
import io.booksync.android.sync.SyncUi
import io.booksync.android.ui.common.messageFor

/** One line under the top bar: syncing, last sync, a problem, or what needs the user. */
@Composable
fun SyncStatusBar(ui: SyncUi, now: Long, onSignIn: () -> Unit, onReview: () -> Unit) {
    val (text, action) = when {
        ui.blocked == Blocked.Reauth -> stringResource(R.string.sync_reauth) to (R.string.sign_in to onSignIn)
        ui.blocked != null -> stringResource(R.string.sync_needs_review) to (R.string.review to onReview)
        ui.running -> stringResource(R.string.syncing) to null
        ui.error == "network" -> stringResource(R.string.sync_offline) to null
        ui.error == "conflict_exhausted" -> stringResource(R.string.sync_conflict) to null
        ui.error != null -> stringResource(messageFor(ui.error)) to null
        ui.lastOkAt != null -> stringResource(R.string.synced_at, DateUtils.getRelativeTimeSpanString(ui.lastOkAt, now, DateUtils.MINUTE_IN_MILLIS).toString()) to null
        else -> return
    }
    val attention = ui.blocked != null || ui.error != null
    Surface(
        color = if (attention) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth().testTag("syncBar"),
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (ui.running) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
            Text(text, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
            action?.let { (label, onClick) -> TextButton(onClick = onClick, modifier = Modifier.testTag("syncAction")) { Text(stringResource(label)) } }
        }
    }
}

/** The server's vault went back in time: the user picks; never automatic. */
@Composable
fun RollbackDialog(onUseLocal: () -> Unit, onAcceptRemote: () -> Unit, onLater: () -> Unit) {
    AlertDialog(
        onDismissRequest = onLater,
        title = { Text(stringResource(R.string.rollback_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.rollback_text))
                TextButton(onClick = onUseLocal, modifier = Modifier.testTag("useLocal")) { Text(stringResource(R.string.rollback_use_local)) }
                TextButton(onClick = onAcceptRemote, modifier = Modifier.testTag("acceptRemote")) { Text(stringResource(R.string.rollback_accept_remote)) }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onLater) { Text(stringResource(R.string.later)) } },
    )
}

/** A merge would delete many bookmarks: show both directions and ask. */
@Composable
fun MassDeletionDialog(pending: Pending, onConfirm: () -> Unit, onLater: () -> Unit) {
    AlertDialog(
        onDismissRequest = onLater,
        title = { Text(stringResource(R.string.mass_deletion_title)) },
        text = {
            val local = pluralStringResource(R.plurals.mass_deletion_local, pending.deletionsToLocal, pending.deletionsToLocal)
            val remote = pluralStringResource(R.plurals.mass_deletion_remote, pending.deletionsToRemote, pending.deletionsToRemote)
            Text(stringResource(R.string.mass_deletion_text, local, remote), modifier = Modifier.testTag("massDeletionText"))
        },
        confirmButton = { TextButton(onClick = onConfirm, modifier = Modifier.testTag("confirmDeletions")) { Text(stringResource(R.string.delete)) } },
        dismissButton = { TextButton(onClick = onLater) { Text(stringResource(R.string.later)) } },
    )
}
