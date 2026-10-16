package io.booksync.android.share

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.edit
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.booksync.android.MainActivity
import io.booksync.android.R
import io.booksync.android.core.CoreProvider
import io.booksync.android.ui.bookmarks.rootTitles
import io.booksync.android.ui.common.messageFor
import io.booksync.android.ui.theme.BookSyncTheme
import io.booksync.android.work.OneShotSyncWorker

/** "Share → BookSync": saves the shared page as a bookmark and schedules its upload. */
class ShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val core = (application as CoreProvider).core
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val text = intent?.takeIf { it.action == Intent.ACTION_SEND }?.getStringExtra(Intent.EXTRA_TEXT)
        val subject = intent?.getStringExtra(Intent.EXTRA_SUBJECT)
        setContent {
            BookSyncTheme {
                val vm: ShareViewModel = viewModel(
                    factory = viewModelFactory {
                        initializer {
                            ShareViewModel(
                                core,
                                lastFolder = { prefs.getString(LAST_FOLDER, null) },
                                rememberFolder = { prefs.edit { putString(LAST_FOLDER, it) } },
                                onSaved = { OneShotSyncWorker.enqueue(applicationContext) },
                            )
                        }
                    },
                )
                val titles = rootTitles()
                LaunchedEffect(Unit) { vm.load(text, subject, titles) }
                ShareSheet(
                    vm,
                    onClose = ::finish,
                    onOpenApp = {
                        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        finish()
                    },
                )
            }
        }
    }

    private companion object {
        const val PREFS = "share"
        const val LAST_FOLDER = "lastFolder"
    }
}

@Composable
fun ShareSheet(vm: ShareViewModel, onClose: () -> Unit, onOpenApp: () -> Unit) {
    val s by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(s.done) { if (s.done) onClose() }
    Surface(shape = MaterialTheme.shapes.extraLarge, tonalElevation = 6.dp) {
        Column(Modifier.padding(24.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.share_title), style = MaterialTheme.typography.titleLarge)
            when {
                s.loading -> CircularProgressIndicator()
                s.signedOut -> {
                    Text(stringResource(R.string.share_signed_out), modifier = Modifier.testTag("signedOut"))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = onClose) { Text(stringResource(R.string.cancel)) }
                        Button(onClick = onOpenApp) { Text(stringResource(R.string.open_app)) }
                    }
                }
                s.url == null -> {
                    Text(stringResource(R.string.share_no_url), modifier = Modifier.testTag("noUrl"))
                    TextButton(onClick = onClose) { Text(stringResource(R.string.ok)) }
                }
                else -> {
                    OutlinedTextField(
                        value = s.title,
                        onValueChange = vm::setTitle,
                        label = { Text(stringResource(R.string.title)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().testTag("shareTitle"),
                    )
                    Text(s.url.orEmpty(), style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(stringResource(R.string.share_folder), style = MaterialTheme.typography.labelLarge)
                    LazyColumn(Modifier.heightIn(max = 240.dp)) {
                        items(s.folders, key = { it.guid }) { f ->
                            val selected = f.guid == s.folder
                            ListItem(
                                headlineContent = { Text(f.title) },
                                colors = ListItemDefaults.colors(
                                    containerColor = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface,
                                ),
                                modifier = Modifier.clickable { vm.setFolder(f.guid) }.padding(start = (16 * f.depth).dp).testTag("folder-${f.guid}"),
                            )
                        }
                    }
                    s.error?.let { Text(stringResource(messageFor(it)), color = MaterialTheme.colorScheme.error) }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = onClose) { Text(stringResource(R.string.cancel)) }
                        Button(onClick = vm::save, enabled = !s.saving, modifier = Modifier.testTag("save")) { Text(stringResource(R.string.save)) }
                    }
                }
            }
        }
    }
}
