package io.booksync.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

// Placeholder until the real UI (plan Task 13): shows the core's status.
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val core = (application as BookSyncApplication).core
        setContent {
            var text by remember { mutableStateOf("…") }
            LaunchedEffect(Unit) { text = runCatching { core.status().toString() }.getOrElse { it.message.orEmpty() } }
            Text(text)
        }
    }
}
