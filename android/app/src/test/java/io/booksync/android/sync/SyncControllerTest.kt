package io.booksync.android.sync

import io.booksync.android.core.FakeCore
import io.booksync.android.core.Pending
import io.booksync.android.core.Recovery
import io.booksync.android.core.Status
import io.booksync.android.core.SyncResult
import io.booksync.android.core.SyncStatus
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

@OptIn(ExperimentalCoroutinesApi::class)
class SyncControllerTest {
    private class Setup(scope: TestScope) {
        val core = FakeCore(Status(signedIn = true))
        val controller = SyncController(core, scope.backgroundScope, now = { scope.testScheduler.currentTime }, random = Random(1))
        val syncs get() = core.calls.count { it == "sync" }
    }

    @Test
    fun syncsOnStartThenPollsUntilStopped() = runTest {
        val s = Setup(this)
        s.controller.start()
        runCurrent()
        assertEquals(1, s.syncs)
        advanceTimeBy(SyncController.POLL_MS + 1)
        assertEquals(2, s.syncs)
        s.controller.stop()
        advanceTimeBy(10 * SyncController.POLL_MS)
        assertEquals("no syncs in the background", 2, s.syncs)
        s.controller.start()
        s.controller.start() // idempotent
        runCurrent()
        assertEquals(3, s.syncs)
    }

    @Test
    fun editsAreDebounced() = runTest {
        val s = Setup(this)
        repeat(5) {
            s.controller.onEdited()
            advanceTimeBy(1_000)
        }
        assertEquals(0, s.syncs)
        advanceTimeBy(SyncController.EDIT_DEBOUNCE_MS)
        assertEquals("one sync for a burst of edits", 1, s.syncs)
    }

    @Test
    fun singleFlightWithOneFollowUp() = runTest {
        val s = Setup(this)
        val gate = CompletableDeferred<Unit>()
        val core = object : io.booksync.android.core.BookSyncCore by s.core {
            var n = 0
            override suspend fun sync(): SyncResult {
                n++
                if (n == 1) gate.await()
                return SyncResult(SyncStatus.OK)
            }
        }
        val c = SyncController(core, backgroundScope, now = { testScheduler.currentTime })
        c.refresh()
        runCurrent()
        assertTrue(c.ui.value.running)
        repeat(3) { c.refresh() }
        gate.complete(Unit)
        runCurrent()
        assertEquals("one run plus exactly one follow-up", 2, core.n)
        assertTrue(!c.ui.value.running)
    }

    @Test
    fun busyCoreGetsOneFollowUp() = runTest {
        val s = Setup(this)
        s.core.syncResults += SyncResult(SyncStatus.BUSY)
        s.controller.refresh()
        runCurrent()
        assertEquals(2, s.syncs)
    }

    @Test
    fun backoffHonorsRetryAfterAndResetsOnSuccess() = runTest {
        val s = Setup(this)
        s.core.syncResults += SyncResult(SyncStatus.ERROR, code = "rate_limited", retryAfterMs = 120_000)
        s.controller.refresh()
        runCurrent()
        assertEquals("rate_limited", s.controller.ui.value.error)
        s.controller.onEdited()
        advanceTimeBy(60_000)
        assertEquals("still backing off", 1, s.syncs)
        advanceTimeBy(61_000)
        s.controller.onEdited()
        advanceTimeBy(SyncController.EDIT_DEBOUNCE_MS + 1)
        assertEquals(2, s.syncs)
        assertNull(s.controller.ui.value.error)
        assertEquals("recorded when the debounced sync ran", 121_000L + SyncController.EDIT_DEBOUNCE_MS, s.controller.ui.value.lastOkAt)
    }

    @Test
    fun forcedRefreshIgnoresBackoff() = runTest {
        val s = Setup(this)
        s.core.syncResults += SyncResult(SyncStatus.ERROR, code = "network")
        s.controller.refresh()
        runCurrent()
        s.controller.refresh()
        runCurrent()
        assertEquals(2, s.syncs)
    }

    @Test
    fun backoffGrowsWithJitterAndCaps() {
        val c = SyncController(FakeCore(), kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), random = Random(7))
        val first = c.backoff(1, 0)
        assertTrue(first in 24_000L..36_000L)
        assertTrue(c.backoff(3, 0) in 96_000L..144_000L)
        assertTrue(c.backoff(20, 0) <= SyncController.BACKOFF_MAX_MS * 12 / 10)
        assertEquals(10 * 60_000L + 0, maxOf(c.backoff(1, 10 * 60_000L), 10 * 60_000L))
    }

    @Test
    fun rollbackBlocksUntilTheUserChooses() = runTest {
        val s = Setup(this)
        s.core.syncResults += SyncResult(SyncStatus.ROLLBACK_DETECTED, remoteSeq = 3, lastSeq = 9)
        s.controller.start()
        runCurrent()
        assertEquals(Blocked.Rollback(3, 9), s.controller.ui.value.blocked)
        advanceTimeBy(5 * SyncController.POLL_MS)
        s.controller.refresh()
        s.controller.onEdited()
        advanceTimeBy(SyncController.EDIT_DEBOUNCE_MS + 1)
        assertEquals("nothing runs while blocked", 1, s.syncs)
        s.controller.resolveRollback(Recovery.USE_LOCAL)
        runCurrent()
        assertTrue("resolveRollback use_local" in s.core.calls)
        assertNull(s.controller.ui.value.blocked)
        s.controller.stop()
    }

    @Test
    fun massDeletionNeedsConfirmation() = runTest {
        val s = Setup(this)
        val pending = Pending(4, 30, 0)
        s.core.syncResults += SyncResult(SyncStatus.NEEDS_CONFIRMATION, pending = pending)
        s.controller.refresh()
        runCurrent()
        assertEquals(Blocked.Confirm(pending), s.controller.ui.value.blocked)
        s.core.syncResults += SyncResult(SyncStatus.OK, changed = true)
        s.controller.confirmDeletions()
        runCurrent()
        assertNull(s.controller.ui.value.blocked)
        assertEquals("the browser must re-read the tree", 1, s.controller.ui.value.treeRevision)
    }

    @Test
    fun revokedDeviceWaitsForSignIn() = runTest {
        val s = Setup(this)
        s.core.syncResults += SyncResult(SyncStatus.SIGNED_OUT)
        s.controller.refresh()
        runCurrent()
        assertEquals(Blocked.Reauth, s.controller.ui.value.blocked)
        s.controller.refresh()
        runCurrent()
        assertEquals(1, s.syncs)
        s.controller.signedIn()
        runCurrent()
        assertEquals(2, s.syncs)
        assertNull(s.controller.ui.value.blocked)
        s.controller.reset()
        assertEquals(SyncUi(treeRevision = 1), s.controller.ui.value)
    }

    @Test
    fun coreExceptionsAndSignedOutDevices() = runTest {
        val s = Setup(this)
        s.core.failNext = io.booksync.android.core.CoreException("internal", "boom")
        s.controller.refresh()
        runCurrent()
        assertEquals("internal", s.controller.ui.value.error)
        s.core.syncResults += SyncResult(SyncStatus.ERROR, code = "not_signed_in")
        s.controller.refresh()
        runCurrent()
        assertNull("not signed in is not an error to show", s.controller.ui.value.error)
    }
}
