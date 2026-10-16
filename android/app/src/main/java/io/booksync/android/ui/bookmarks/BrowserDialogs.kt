package io.booksync.android.ui.bookmarks

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.booksync.android.R
import io.booksync.android.core.VNode

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BrowserDialogs(state: BrowserState, vm: BookmarksViewModel) {
    when (val d = state.dialog) {
        null -> Unit
        is BrowserDialog.Actions -> ModalBottomSheet(onDismissRequest = vm::dismissDialog) {
            Column(Modifier.padding(bottom = 24.dp)) {
                Text(d.node.title, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
                SheetAction(R.string.rename, "action-rename") { vm.show(BrowserDialog.Rename(d.node)) }
                if (!d.node.isFolder) SheetAction(R.string.edit_url, "action-url") { vm.show(BrowserDialog.EditUrl(d.node)) }
                SheetAction(R.string.move, "action-move") { vm.show(BrowserDialog.Move(d.node)) }
                SheetAction(R.string.delete, "action-delete") { vm.requestDelete(d.node) }
            }
        }
        is BrowserDialog.AddBookmark -> TextFieldsDialog(
            title = R.string.add_bookmark,
            fields = listOf(Field(R.string.title, ""), Field(R.string.url, "https://", KeyboardType.Uri)),
            onDismiss = vm::dismissDialog,
        ) { (title, url) -> vm.addBookmark(d.parent, title, url) }
        is BrowserDialog.AddFolder -> TextFieldsDialog(R.string.add_folder, listOf(Field(R.string.title, "")), vm::dismissDialog) { (title) ->
            vm.addFolder(d.parent, title)
        }
        is BrowserDialog.Rename -> TextFieldsDialog(R.string.rename, listOf(Field(R.string.title, d.node.title)), vm::dismissDialog) { (title) ->
            vm.rename(d.node.guid, title)
        }
        is BrowserDialog.EditUrl -> TextFieldsDialog(R.string.edit_url, listOf(Field(R.string.url, d.node.url.orEmpty(), KeyboardType.Uri)), vm::dismissDialog) { (url) ->
            vm.setUrl(d.node.guid, url)
        }
        is BrowserDialog.Move -> MovePicker(d.node, vm)
        is BrowserDialog.ConfirmDelete -> AlertDialog(
            onDismissRequest = vm::dismissDialog,
            title = { Text(stringResource(R.string.delete_title, d.node.title)) },
            text = {
                if (d.node.isFolder) {
                    Text(pluralStringResource(R.plurals.delete_folder_contents, d.bookmarks + d.folders, d.bookmarks + d.folders))
                }
            },
            confirmButton = { TextButton(onClick = { vm.delete(d.node.guid) }, modifier = Modifier.testTag("confirmDelete")) { Text(stringResource(R.string.delete)) } },
            dismissButton = { TextButton(onClick = vm::dismissDialog) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun SheetAction(label: Int, tag: String, onClick: () -> Unit) {
    ListItem(headlineContent = { Text(stringResource(label)) }, modifier = Modifier.clickable(onClick = onClick).testTag(tag))
}

private data class Field(val label: Int, val initial: String, val keyboard: KeyboardType = KeyboardType.Text)

@Composable
private fun TextFieldsDialog(title: Int, fields: List<Field>, onDismiss: () -> Unit, onConfirm: (List<String>) -> Unit) {
    val values = fields.map { f -> rememberSaveable(f) { mutableStateOf(f.initial) } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(title)) },
        text = {
            Column {
                fields.forEachIndexed { i, f ->
                    var v by values[i]
                    OutlinedTextField(
                        value = v,
                        onValueChange = { v = it },
                        label = { Text(stringResource(f.label)) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = f.keyboard),
                        modifier = Modifier.fillMaxWidth().testTag("field-$i"),
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = { onConfirm(values.map { it.value }) }, modifier = Modifier.testTag("dialogOk")) { Text(stringResource(R.string.ok)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

@Composable
private fun MovePicker(node: VNode, vm: BookmarksViewModel) {
    AlertDialog(
        onDismissRequest = vm::dismissDialog,
        title = { Text(stringResource(R.string.move_to)) },
        text = {
            LazyColumn(Modifier.heightIn(max = 400.dp)) {
                items(vm.moveTargets(node), key = { it.guid }) { f ->
                    ListItem(
                        headlineContent = { Text(f.title) },
                        modifier = Modifier.clickable { vm.move(node.guid, f.guid) }.padding(start = (16 * f.depth).dp).testTag("target-${f.guid}"),
                    )
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = vm::dismissDialog) { Text(stringResource(R.string.cancel)) } },
    )
}
