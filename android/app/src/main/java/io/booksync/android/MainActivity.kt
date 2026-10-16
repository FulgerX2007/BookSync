package io.booksync.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import io.booksync.core.mobile.Mobile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// Spike (plan Task 1): calls the Go core once and shows the result.
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            var result by remember { mutableStateOf("…") }
            LaunchedEffect(Unit) {
                result = withContext(Dispatchers.IO) { Mobile.ping("https://www.google.com/") }
            }
            Text("Go core: $result")
        }
    }
}
