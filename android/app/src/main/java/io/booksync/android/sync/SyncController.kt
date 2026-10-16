package io.booksync.android.sync

import io.booksync.android.core.BookSyncCore
import io.booksync.android.core.CoreException
import io.booksync.android.core.Pending
import io.booksync.android.core.Recovery
import io.booksync.android.core.SyncResult
import io.booksync.android.core.SyncStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.min
import kotlin.random.Random

/** What waits for the user before automatic syncs may continue. */
sealed interface Blocked {
    /** The server's vault went back in time (protocol §4.3); never resolved automatically. */
    data class Rollback(val remoteSeq: Long?, val lastSeq: Long) : Blocked
    /** A merge would delete many bookmarks (protocol §4.6). */
    data class Confirm(val pending: Pending) : Blocked
    /** The server revoked this device; sign in again. */
    data object Reauth : Blocked
}

data class SyncUi(
    val running: Boolean = false,
    /** Wall-clock time of the last successful run. */
    val lastOkAt: Long? = null,
    /** Error code of the last failed run (network, rate_limited, conflict_exhausted, …). */
    val error: String? = null,
    val blocked: Blocked? = null,
    /** Increments whenever a sync replaced the local tree; the browser re-reads it. */
    val treeRevision: Long = 0,
)

/**
 * Runs syncs while the app is in the foreground (no periodic background sync
 * in v1): on start, [EDIT_DEBOUNCE_MS] after the last edit, every
 * [POLL_MS], and on pull-to-refresh. Runs are single-flight; requests during
 * a run cause exactly one follow-up. Failures back off exponentially with
 * jitter (30 s up to 15 min, at least Retry-After), like the extension's
 * scheduler. Backoff is in memory: a fresh start tries again at once.
 */
class SyncController(
    private val core: BookSyncCore,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
    private val random: Random = Random.Default,
) {
    private val _ui = MutableStateFlow(SyncUi())
    val ui: StateFlow<SyncUi> = _ui.asStateFlow()

    private var running = false
    private var again = false
    private var failures = 0
    private var nextAttemptAt = 0L
    private var poll: Job? = null
    private var debounce: Job? = null

    /** The app came to the foreground. */
    fun start() {
        if (poll?.isActive == true) return
        request(force = false)
        poll = scope.launch {
            while (isActive) {
                delay(POLL_MS)
                request(force = false)
            }
        }
    }

    /** The app left the foreground: no more automatic syncs. */
    fun stop() {
        poll?.cancel()
        poll = null
        debounce?.cancel()
        debounce = null
    }

    /** A local edit: sync once the user pauses. */
    fun onEdited() {
        debounce?.cancel()
        debounce = scope.launch {
            delay(EDIT_DEBOUNCE_MS)
            request(force = false)
        }
    }

    /** Pull-to-refresh or a sign-in: now, regardless of backoff (but not of a block). */
    fun refresh() = request(force = true)

    fun confirmDeletions() = runUserAction { core.confirmDeletions() }

    fun resolveRollback(choice: Recovery) = runUserAction { core.resolveRollback(choice) }

    /** After signing in again: lift the re-auth block and sync. */
    fun signedIn() {
        _ui.update { it.copy(blocked = null, error = null) }
        failures = 0
        nextAttemptAt = 0
        refresh()
    }

    /** After sign-out: forget everything shown. */
    fun reset() {
        failures = 0
        nextAttemptAt = 0
        _ui.update { SyncUi(treeRevision = it.treeRevision + 1) }
    }

    private fun request(force: Boolean) {
        if (_ui.value.blocked != null) return
        if (!force && now() < nextAttemptAt) return
        if (running) {
            again = true
            return
        }
        launchRun { core.sync() }
    }

    private fun runUserAction(action: suspend () -> SyncResult) {
        if (running) {
            again = true
            return
        }
        _ui.update { it.copy(blocked = null) }
        launchRun(action)
    }

    private fun launchRun(action: suspend () -> SyncResult) {
        running = true
        _ui.update { it.copy(running = true) }
        scope.launch {
            val result = try {
                action()
            } catch (e: CoreException) {
                SyncResult(SyncStatus.ERROR, code = e.code, message = e.message)
            }
            handle(result)
            running = false
            _ui.update { it.copy(running = false) }
            if (again) {
                again = false
                request(force = false)
            }
        }
    }

    private fun handle(r: SyncResult) {
        when (r.status) {
            SyncStatus.OK -> {
                failures = 0
                nextAttemptAt = 0
                _ui.update { it.copy(lastOkAt = now(), error = null, blocked = null, treeRevision = it.treeRevision + if (r.changed) 1 else 0) }
            }
            SyncStatus.BUSY -> again = true // another run (the share worker) holds the core
            SyncStatus.ROLLBACK_DETECTED -> _ui.update { it.copy(blocked = Blocked.Rollback(r.remoteSeq, r.lastSeq)) }
            SyncStatus.NEEDS_CONFIRMATION -> _ui.update { it.copy(blocked = r.pending?.let(Blocked::Confirm)) }
            SyncStatus.SIGNED_OUT -> _ui.update { it.copy(blocked = Blocked.Reauth) }
            else -> {
                // error, conflict_exhausted: back off.
                if (r.code == "not_signed_in") {
                    _ui.update { it.copy(error = null) }
                    return
                }
                failures++
                nextAttemptAt = now() + backoff(failures, r.retryAfterMs)
                _ui.update { it.copy(error = r.code ?: r.status) }
            }
        }
    }

    /** 30 s · 2^(n-1), at most 15 min, ±20 % jitter, never less than Retry-After. */
    internal fun backoff(failures: Int, retryAfterMs: Long): Long {
        val base = min(BACKOFF_MIN_MS shl min(failures - 1, 10), BACKOFF_MAX_MS)
        val jittered = (base * (0.8 + 0.4 * random.nextDouble())).toLong()
        return maxOf(jittered, retryAfterMs)
    }

    companion object {
        const val EDIT_DEBOUNCE_MS = 3_000L
        const val POLL_MS = 60_000L
        const val BACKOFF_MIN_MS = 30_000L
        const val BACKOFF_MAX_MS = 15 * 60_000L
    }
}
