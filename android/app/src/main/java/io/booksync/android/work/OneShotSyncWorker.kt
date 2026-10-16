package io.booksync.android.work

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.booksync.android.core.CoreException
import io.booksync.android.core.CoreProvider
import io.booksync.android.core.SyncResult
import io.booksync.android.core.SyncStatus
import java.util.concurrent.TimeUnit

/**
 * Uploads a bookmark shared while the app was closed: one sync once the
 * network is up. Not periodic; anything needing the user (a rollback, a
 * mass-deletion prompt, a revoked device) waits for the next app start.
 */
class OneShotSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val core = (applicationContext as? CoreProvider)?.core ?: return Result.failure()
        val r = try {
            core.sync()
        } catch (e: CoreException) {
            SyncResult(SyncStatus.ERROR, code = e.code)
        }
        return outcome(r)
    }

    companion object {
        private const val NAME = "booksync-share-sync"

        /** Transient failures retry with backoff; everything else is left to the foreground. */
        fun outcome(r: SyncResult): Result = when {
            r.status == SyncStatus.BUSY -> Result.retry()
            r.status == SyncStatus.ERROR && r.code in TRANSIENT -> Result.retry()
            else -> Result.success()
        }

        private val TRANSIENT = setOf("network", "rate_limited", "server")

        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<OneShotSyncWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            // One pending sync covers any number of shares: it uploads the whole tree.
            WorkManager.getInstance(context).enqueueUniqueWork(NAME, ExistingWorkPolicy.KEEP, request)
        }
    }
}
