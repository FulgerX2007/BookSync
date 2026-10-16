package io.booksync.android.ui.auth

import android.content.ClipData
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.booksync.android.R
import io.booksync.android.core.Kit
import io.booksync.android.ui.common.SecureScreen
import kotlinx.coroutines.launch

/** Shown once after registration; continuing requires confirming the kit was saved. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmergencyKitScreen(kit: Kit, onContinue: () -> Unit) {
    SecureScreen()
    var saved by rememberSaveable { mutableStateOf(false) }
    val clipboard = LocalClipboard.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.kit_title)) }) }) { pad ->
        Column(
            Modifier.fillMaxSize().padding(pad).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.kit_intro))
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text(stringResource(R.string.sync_id), style = MaterialTheme.typography.labelMedium)
                    SelectionContainer {
                        Text(kit.syncId, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("kitSyncId"))
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = {
                    scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("BookSync Emergency Kit", kit.text))) }
                }) { Text(stringResource(R.string.copy)) }
                OutlinedButton(onClick = {
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain")
                        .putExtra(Intent.EXTRA_SUBJECT, kit.fileName)
                        .putExtra(Intent.EXTRA_TEXT, kit.text)
                    context.startActivity(Intent.createChooser(send, null))
                }) { Text(stringResource(R.string.share_or_save)) }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = saved, onCheckedChange = { saved = it }, modifier = Modifier.testTag("kitSaved"))
                Text(stringResource(R.string.kit_saved))
            }
            Button(onClick = onContinue, enabled = saved, modifier = Modifier.fillMaxWidth().testTag("kitContinue")) {
                Text(stringResource(R.string.continue_label))
            }
        }
    }
}
