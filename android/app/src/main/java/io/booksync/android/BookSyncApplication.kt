package io.booksync.android

import android.app.Application
import android.os.Build
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.lifecycleScope
import io.booksync.android.core.BookSyncCore
import io.booksync.android.core.GoCore
import io.booksync.android.security.KeystoreKeyWrapper
import io.booksync.android.sync.SyncController
import java.io.File

/**
 * Owns the single core of this process and the foreground sync controller;
 * the UI and the share worker use the same instances.
 */
class BookSyncApplication : Application() {
    val core: BookSyncCore by lazy {
        GoCore.open(File(filesDir, "booksync"), KeystoreKeyWrapper(), deviceName())
    }

    val sync: SyncController by lazy {
        SyncController(core, ProcessLifecycleOwner.get().lifecycleScope)
    }

    override fun onCreate() {
        super.onCreate()
        // Sync only while some screen of the app is visible.
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) = sync.start()
                override fun onStop(owner: LifecycleOwner) = sync.stop()
            },
        )
    }

    private fun deviceName(): String {
        val model = listOf(Build.MANUFACTURER, Build.MODEL).filter { it.isNotBlank() }.distinct().joinToString(" ")
        return model.ifBlank { "Android" }.take(64)
    }
}
