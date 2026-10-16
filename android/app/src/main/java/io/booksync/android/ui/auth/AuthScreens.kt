package io.booksync.android.ui.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import io.booksync.android.R
import io.booksync.android.ui.common.SecureScreen
import io.booksync.android.ui.common.messageFor

@Composable
fun WelcomeScreen(onCreate: () -> Unit, onSignIn: () -> Unit) {
    Scaffold { pad ->
        Column(
            Modifier.fillMaxSize().padding(pad).padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineLarge)
            Spacer(Modifier.height(8.dp))
            Text(stringResource(R.string.welcome_tagline), style = MaterialTheme.typography.bodyLarge)
            Spacer(Modifier.height(32.dp))
            Button(onClick = onSignIn, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.sign_in)) }
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = onCreate, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.create_account)) }
            Spacer(Modifier.height(24.dp))
            Text(stringResource(R.string.welcome_note), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FormScaffold(title: String, onBack: () -> Unit, content: @Composable () -> Unit) {
    SecureScreen()
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
            )
        },
    ) { pad ->
        Column(
            Modifier.fillMaxSize().padding(pad).imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) { content() }
    }
}

@Composable
private fun ServerField(form: AuthForm, vm: AuthViewModel) = OutlinedTextField(
    value = form.serverUrl,
    onValueChange = vm::setServerUrl,
    label = { Text(stringResource(R.string.server_url)) },
    placeholder = { Text("https://sync.example.com") },
    singleLine = true,
    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
    modifier = Modifier.fillMaxWidth().testTag("server"),
)

@Composable
private fun UsernameField(form: AuthForm, vm: AuthViewModel) = OutlinedTextField(
    value = form.username,
    onValueChange = vm::setUsername,
    label = { Text(stringResource(R.string.username)) },
    singleLine = true,
    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Next),
    modifier = Modifier.fillMaxWidth().testTag("username"),
)

@Composable
private fun PasswordField(value: String, onChange: (String) -> Unit, label: Int, tag: String, error: Int?) = OutlinedTextField(
    value = value,
    onValueChange = onChange,
    label = { Text(stringResource(label)) },
    singleLine = true,
    isError = error != null,
    supportingText = error?.let { { Text(stringResource(it)) } },
    visualTransformation = PasswordVisualTransformation(),
    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, imeAction = ImeAction.Next),
    modifier = Modifier.fillMaxWidth().testTag(tag),
)

@Composable
private fun SubmitButton(label: Int, enabled: Boolean, busy: Boolean, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth().testTag("submit")) {
        if (busy) CircularProgressIndicator(Modifier.height(20.dp)) else Text(stringResource(label))
    }
}

@Composable
private fun FormError(code: String?) {
    if (code != null) {
        Text(stringResource(messageFor(code)), color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("error"))
    }
}

@Composable
fun RegisterScreen(form: AuthForm, vm: AuthViewModel, onBack: () -> Unit, onRegistered: (io.booksync.android.core.Kit) -> Unit) {
    FormScaffold(stringResource(R.string.create_account), onBack) {
        ServerField(form, vm)
        UsernameField(form, vm)
        PasswordField(form.password, vm::setPassword, R.string.password, "password", R.string.password_hint.takeIf { form.passwordTooShort })
        PasswordField(form.confirm, vm::setConfirm, R.string.password_confirm, "confirm", R.string.password_mismatch.takeIf { form.confirmMismatch })
        Text(stringResource(R.string.register_note), style = MaterialTheme.typography.bodySmall)
        FormError(form.error)
        SubmitButton(R.string.create_account, form.canRegister, form.busy) { vm.register(onRegistered) }
    }
}

@Composable
fun LoginScreen(form: AuthForm, vm: AuthViewModel, reauth: Boolean, onBack: () -> Unit, onSignedIn: () -> Unit) {
    FormScaffold(stringResource(if (reauth) R.string.sign_in_again else R.string.sign_in), onBack) {
        if (reauth) Text(stringResource(R.string.reauth_note), style = MaterialTheme.typography.bodyMedium)
        ServerField(form, vm)
        UsernameField(form, vm)
        PasswordField(form.password, vm::setPassword, R.string.password, "password", null)
        OutlinedTextField(
            value = form.syncId,
            onValueChange = vm::setSyncId,
            label = { Text(stringResource(R.string.sync_id)) },
            placeholder = { Text("BS1-XXXX-XXXX-…") },
            singleLine = true,
            isError = form.syncIdError != null,
            supportingText = { Text(stringResource(form.syncIdError?.let(::messageFor) ?: R.string.sync_id_hint)) },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth().testTag("syncId"),
        )
        FormError(form.error)
        SubmitButton(R.string.sign_in, form.canLogin, form.busy) { vm.login(onSignedIn) }
    }
}
