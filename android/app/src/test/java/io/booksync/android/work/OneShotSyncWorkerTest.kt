package io.booksync.android.work

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import io.booksync.android.core.BookSyncCore
import io.booksync.android.core.CoreException
import io.booksync.android.core.CoreProvider
import io.booksync.android.core.FakeCore
import io.booksync.android.core.Status
import io.booksync.android.core.SyncResult
import io.booksync.android.core.SyncStatus
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Replaces BookSyncApplication (whose native core cannot load on the JVM). */
class TestApp : Application(), CoreProvider {
    override val core: BookSyncCore get() = fake
    companion object {
        var fake = FakeCore(Status(signedIn = true))
    }
}

@RunWith(AndroidJUnit4::class)
@Config(application = TestApp::class)
class OneShotSyncWorkerTest {
    private fun run(result: SyncResult? = null, fail: CoreException? = null): ListenableWorker.Result {
        TestApp.fake = FakeCore(Status(signedIn = true)).apply {
            result?.let { syncResults += it }
            failNext = fail
        }
        val worker = TestListenableWorkerBuilder<OneShotSyncWorker>(ApplicationProvider.getApplicationContext()).build()
        return runBlocking { worker.doWork() }
    }

    @Test
    fun mapsResults() {
        assertEquals(ListenableWorker.Result.success(), run(SyncResult(SyncStatus.OK, uploaded = true)))
        assertEquals("transient", ListenableWorker.Result.retry(), run(SyncResult(SyncStatus.ERROR, code = "network")))
        assertEquals(ListenableWorker.Result.retry(), run(SyncResult(SyncStatus.ERROR, code = "rate_limited")))
        assertEquals("the app's controller is mid-run", ListenableWorker.Result.retry(), run(SyncResult(SyncStatus.BUSY)))
        for (s in listOf(SyncStatus.NEEDS_CONFIRMATION, SyncStatus.ROLLBACK_DETECTED, SyncStatus.SIGNED_OUT, SyncStatus.CONFLICT_EXHAUSTED)) {
            assertEquals("$s waits for the app", ListenableWorker.Result.success(), run(SyncResult(s)))
        }
        assertEquals(ListenableWorker.Result.success(), run(SyncResult(SyncStatus.ERROR, code = "not_signed_in")))
        assertEquals(ListenableWorker.Result.success(), run(fail = CoreException("internal", "boom")))
        assertEquals(listOf("sync"), TestApp.fake.calls)
    }

    @Test
    fun enqueueIsUnique() {
        // With WorkManager's test initializer, enqueueing twice keeps one request.
        val ctx = ApplicationProvider.getApplicationContext<Application>()
        androidx.work.testing.WorkManagerTestInitHelper.initializeTestWorkManager(ctx)
        OneShotSyncWorker.enqueue(ctx)
        OneShotSyncWorker.enqueue(ctx)
        val infos = androidx.work.WorkManager.getInstance(ctx).getWorkInfosForUniqueWork("booksync-share-sync").get()
        assertEquals(1, infos.size)
    }
}
