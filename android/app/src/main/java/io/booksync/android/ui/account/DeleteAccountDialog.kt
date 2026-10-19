package io.booksync.android.ui.account

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy
import io.booksync.android.R
import io.booksync.android.ui.AccountDeletion
import io.booksync.android.ui.common.messageFor

/**
 * Confirms a permanent account deletion with the username and password, like
 * the extension's options page. The dialog window is FLAG_SECURE (it holds a
 * password); the fields live only as long as the dialog.
 */
@Composable
fun DeleteAccountDialog(
    username: String,
    state: AccountDeletion,
    onDelete: (confirmUsername: String, password: String) -> Unit,
    onDismiss: () -> Unit,
) {
    var typed by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(securePolicy = SecureFlagPolicy.SecureOn, dismissOnClickOutside = false),
        title = { Text(stringResource(R.string.delete_account_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.delete_account_message))
                Text(stringResource(R.string.delete_account_confirm, username))
                OutlinedTextField(
                    value = typed,
                    onValueChange = { typed = it },
                    label = { Text(stringResource(R.string.username)) },
                    singleLine = true,
                    enabled = !state.busy,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                    modifier = Modifier.testTag("deleteUsername"),
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text(stringResource(R.string.password)) },
                    singleLine = true,
                    enabled = !state.busy,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                    modifier = Modifier.testTag("deletePassword"),
                )
                state.error?.let { Text(stringResource(messageFor(it)), color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("deleteError")) }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onDelete(typed, password) },
                enabled = !state.busy && typed.isNotBlank() && password.isNotEmpty(),
                modifier = Modifier.testTag("deleteConfirm"),
            ) { Text(stringResource(R.string.delete_account_action), color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !state.busy) { Text(stringResource(R.string.cancel)) } },
    )
}
