package io.booksync.android.core

import io.booksync.core.mobile.Core
import io.booksync.core.mobile.KeyWrapper
import io.booksync.core.mobile.Mobile
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.text.Normalizer

/**
 * [BookSyncCore] backed by the Go core AAR. Create exactly one per process
 * (see BookSyncApplication): the core serializes access to its state file.
 */
class GoCore private constructor(
    private val core: Core,
    private val io: CoroutineDispatcher,
) : BookSyncCore {

    private suspend fun <T> call(block: Core.() -> T): T = withContext(io) {
        try {
            core.block()
        } catch (e: Exception) {
            throw CoreException.from(e)
        }
    }

    private suspend inline fun <reified T> json(crossinline block: Core.() -> String): T =
        coreJson.decodeFromString(call { block() })

    override suspend fun register(serverUrl: String, username: String, password: String): Kit =
        json { register(serverUrl, username, nfc(password)) }

    override suspend fun login(serverUrl: String, username: String, password: String, syncId: String) =
        call { login(serverUrl, username, nfc(password), syncId) }

    override suspend fun logout() = call { logout() }
    override suspend fun status(): Status = json { status() }
    override suspend fun tree(): Tree = json { tree() }

    override suspend fun addBookmark(parent: String, position: Position, title: String, url: String): String =
        call { position.let { addBookmark(parent, it.after, it == Position.End, title, url) } }

    override suspend fun addFolder(parent: String, position: Position, title: String): String =
        call { addFolder(parent, position.after, position == Position.End, title) }

    override suspend fun rename(guid: String, title: String) = call { rename(guid, title) }
    override suspend fun setUrl(guid: String, url: String) = call { setURL(guid, url) }
    override suspend fun move(guid: String, parent: String, position: Position) =
        call { move(guid, parent, position.after, position == Position.End) }

    override suspend fun delete(guid: String) = call { delete(guid) }
    override suspend fun countSubtree(guid: String): SubtreeCount = json { countSubtree(guid) }
    override suspend fun sync(): SyncResult = json { sync() }
    override suspend fun confirmDeletions(): SyncResult = json { confirmDeletions() }
    override suspend fun resolveRollback(choice: Recovery): SyncResult = json { resolveRollback(choice.wire) }

    override fun parseSyncId(text: String): String =
        try {
            Mobile.parseSyncID(text)
        } catch (e: Exception) {
            throw CoreException.from(e)
        }

    companion object {
        fun open(dir: File, wrapper: KeyWrapper, deviceName: String, io: CoroutineDispatcher = Dispatchers.IO): GoCore {
            dir.mkdirs()
            val core = try {
                Mobile.newCore(dir.absolutePath, wrapper, deviceName)
            } catch (e: Exception) {
                throw CoreException.from(e)
            }
            return GoCore(core, io)
        }
    }
}

/** Anchor GUID for the core: "" means first. */
internal val Position.after: String
    get() = (this as? Position.After)?.guid.orEmpty()

/** The protocol derives keys from the NFC form; Go's stdlib cannot normalize, so Kotlin does. */
internal fun nfc(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFC)
