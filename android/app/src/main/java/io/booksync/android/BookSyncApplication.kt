package io.booksync.android

import android.app.Application
import android.os.Build
import io.booksync.android.core.BookSyncCore
import io.booksync.android.core.GoCore
import io.booksync.android.security.KeystoreKeyWrapper
import java.io.File

/** Owns the single core of this process; UI, sync controller and worker share it. */
class BookSyncApplication : Application() {
    val core: BookSyncCore by lazy {
        GoCore.open(File(filesDir, "booksync"), KeystoreKeyWrapper(), deviceName())
    }

    private fun deviceName(): String {
        val model = listOf(Build.MANUFACTURER, Build.MODEL).filter { it.isNotBlank() }.distinct().joinToString(" ")
        return model.ifBlank { "Android" }.take(64)
    }
}
