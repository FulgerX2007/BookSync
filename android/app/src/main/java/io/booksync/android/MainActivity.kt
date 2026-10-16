package io.booksync.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.booksync.android.ui.BookSyncApp
import io.booksync.android.ui.SignOutDialog

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val core = (application as BookSyncApplication).core
        setContent {
            BookSyncApp(core) { app ->
                // Placeholder home until the bookmark browser (plan Task 14).
                var confirm by remember { mutableStateOf(false) }
                val status by app.status.collectAsStateWithLifecycle()
                Scaffold { pad ->
                    Column(Modifier.fillMaxSize().padding(pad).padding(24.dp)) {
                        Text(status.username.orEmpty())
                        Button(onClick = { confirm = true }) { Text(stringResource(R.string.sign_out)) }
                    }
                }
                if (confirm) SignOutDialog(onConfirm = { confirm = false; app.signOut() }, onDismiss = { confirm = false })
            }
        }
    }
}
