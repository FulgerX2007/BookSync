package io.booksync.android.core

/** Where a new or moved node goes. */
sealed interface Position {
    data object First : Position
    data object End : Position
    data class After(val guid: String) : Position
}

/**
 * The app's view of the Go core. UI and ViewModels depend on this interface,
 * so JVM tests use a fake: the native core cannot load under Robolectric.
 * All calls are main-safe; failures throw [CoreException].
 */
interface BookSyncCore {
    suspend fun register(serverUrl: String, username: String, password: String): Kit
    suspend fun login(serverUrl: String, username: String, password: String, syncId: String)
    suspend fun logout()
    suspend fun status(): Status
    suspend fun tree(): Tree

    suspend fun addBookmark(parent: String, position: Position, title: String, url: String): String
    suspend fun addFolder(parent: String, position: Position, title: String): String
    suspend fun rename(guid: String, title: String)
    suspend fun setUrl(guid: String, url: String)
    suspend fun move(guid: String, parent: String, position: Position)
    suspend fun delete(guid: String)
    suspend fun countSubtree(guid: String): SubtreeCount

    suspend fun sync(): SyncResult
    suspend fun confirmDeletions(): SyncResult
    suspend fun resolveRollback(choice: Recovery): SyncResult

    /** Validates a typed SyncID and returns its canonical form. */
    fun parseSyncId(text: String): String
}

enum class Recovery(val wire: String) {
    USE_LOCAL("use_local"),
    ACCEPT_REMOTE("accept_remote"),
}
