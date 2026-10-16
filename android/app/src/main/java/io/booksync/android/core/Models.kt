package io.booksync.android.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** JSON shapes returned by the Go core (mobile/core.go); fixtures in src/test/resources guard them. */
internal val coreJson = Json { ignoreUnknownKeys = true }

object Roots {
    const val TOOLBAR = "toolbar_____"
    const val MENU = "menu________"
    const val OTHER = "unfiled_____"
    const val MOBILE = "mobile______"
    val ALL = listOf(TOOLBAR, MENU, OTHER, MOBILE)
}

@Serializable
enum class NodeKind {
    @SerialName("folder") FOLDER,
    @SerialName("bookmark") BOOKMARK,
}

@Serializable
data class VNode(
    val guid: String,
    val kind: NodeKind,
    val title: String,
    val url: String? = null,
    val children: List<String>? = null,
) {
    val isFolder: Boolean get() = kind == NodeKind.FOLDER
}

/** The local bookmark tree (the vault document). */
@Serializable
data class Tree(
    val format: Int,
    val seq: Long,
    val writtenBy: String,
    val writtenAt: Double,
    val nodes: Map<String, VNode>,
) {
    fun node(guid: String): VNode? = nodes[guid]

    fun children(folder: String): List<VNode> = nodes[folder]?.children.orEmpty().mapNotNull { nodes[it] }

    /** Parent of every node, roots excluded. */
    val parents: Map<String, String> by lazy {
        buildMap { nodes.values.forEach { n -> n.children?.forEach { put(it, n.guid) } } }
    }

    /** Folder path from a root down to (and including) [guid]. */
    fun path(guid: String): List<VNode> {
        val out = ArrayDeque<VNode>()
        var g: String? = guid
        val seen = HashSet<String>()
        while (g != null && seen.add(g)) {
            nodes[g]?.let { out.addFirst(it) }
            g = parents[g]
        }
        return out
    }

    fun isRoot(guid: String) = guid in Roots.ALL
}

@Serializable
data class Pending(
    val remoteVersion: Long? = null,
    val deletionsToLocal: Int,
    val deletionsToRemote: Int,
)

@Serializable
data class Rollback(
    val remoteVersion: Long,
    /** Null when the server's vault was emptied. */
    val remoteSeq: Long? = null,
    val lastSeq: Long,
)

@Serializable
data class Status(
    val signedIn: Boolean = false,
    val needsReauth: Boolean = false,
    val serverUrl: String? = null,
    val username: String? = null,
    val syncStatus: String? = null,
    val lastError: String? = null,
    val lastSyncAt: Long? = null,
    val pendingConfirmation: Pending? = null,
    val rollback: Rollback? = null,
    val localRev: Long = 0,
    val notice: String? = null,
) {
    val hasAccount: Boolean get() = signedIn || needsReauth
}

object SyncStatus {
    const val OK = "ok"
    const val NEEDS_CONFIRMATION = "needs_confirmation"
    const val ROLLBACK_DETECTED = "rollback_detected"
    const val CONFLICT_EXHAUSTED = "conflict_exhausted"
    const val SIGNED_OUT = "signed_out"
    const val BUSY = "busy"
    const val ERROR = "error"
}

@Serializable
data class SyncResult(
    val status: String,
    val uploaded: Boolean = false,
    val version: Long = 0,
    val changed: Boolean = false,
    val pending: Pending? = null,
    val remoteSeq: Long? = null,
    val lastSeq: Long = 0,
    val code: String? = null,
    val message: String? = null,
    val retryAfterMs: Long = 0,
)

@Serializable
data class Kit(val text: String, val syncId: String, val fileName: String)

@Serializable
data class SubtreeCount(val bookmarks: Int, val folders: Int)

@Serializable
internal data class ErrorBody(val code: String, val message: String)

/** A failure from the core; callers branch on [code] (same codes as the extension). */
class CoreException(val code: String, message: String) : Exception(message) {
    companion object {
        /** Decodes the core's error JSON, or wraps anything else as "internal". */
        fun from(e: Throwable): CoreException {
            if (e is CoreException) return e
            val body = runCatching { coreJson.decodeFromString<ErrorBody>(e.message.orEmpty()) }.getOrNull()
            return if (body != null) CoreException(body.code, body.message) else CoreException("internal", e.message ?: e.toString())
        }
    }
}
