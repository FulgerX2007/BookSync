package io.booksync.android.core

/**
 * In-memory [BookSyncCore] for JVM tests. Edits change [tree] like the Go
 * core would (simplified); [syncResults] scripts sync outcomes; [failNext]
 * makes the next call throw.
 */
class FakeCore(var status: Status = Status()) : BookSyncCore {
    var tree: Tree = emptyTree()
    val syncResults = ArrayDeque<SyncResult>()
    var failNext: CoreException? = null
    val calls = mutableListOf<String>()
    var kit = Kit("BookSync Emergency Kit", "BS1-0000-0000-0000-0000-0000-0000-0000", "booksync-emergency-kit-alice.txt")
    private var next = 0

    private fun record(call: String) {
        calls += call
        failNext?.let {
            failNext = null
            throw it
        }
    }

    override suspend fun register(serverUrl: String, username: String, password: String): Kit {
        record("register $serverUrl $username")
        status = Status(signedIn = true, serverUrl = serverUrl, username = username)
        return kit
    }

    override suspend fun login(serverUrl: String, username: String, password: String, syncId: String) {
        record("login $serverUrl $username $syncId")
        status = Status(signedIn = true, serverUrl = serverUrl, username = username)
    }

    override suspend fun logout() {
        record("logout")
        status = Status()
        tree = emptyTree()
    }

    override suspend fun status(): Status = status
    override suspend fun tree(): Tree = tree

    private fun insert(parent: String, position: Position, node: VNode): String {
        val p = tree.nodes[parent] ?: throw CoreException("stale", "gone")
        if (!p.isFolder) throw CoreException("not_folder", "not a folder")
        val kids = p.children.orEmpty().toMutableList()
        when (position) {
            Position.First -> kids.add(0, node.guid)
            Position.End -> kids.add(node.guid)
            is Position.After -> kids.add(kids.indexOf(position.guid).also { if (it < 0) throw CoreException("stale", "anchor") } + 1, node.guid)
        }
        tree = tree.copy(nodes = tree.nodes + (node.guid to node) + (parent to p.copy(children = kids)))
        status = status.copy(localRev = status.localRev + 1)
        return node.guid
    }

    override suspend fun addBookmark(parent: String, position: Position, title: String, url: String): String {
        record("addBookmark $parent $title $url")
        if (!url.contains(":")) throw CoreException("invalid_url", "Enter a full URL")
        return insert(parent, position, VNode("g${next++}", NodeKind.BOOKMARK, title, url = url))
    }

    override suspend fun addFolder(parent: String, position: Position, title: String): String {
        record("addFolder $parent $title")
        return insert(parent, position, VNode("g${next++}", NodeKind.FOLDER, title, children = emptyList()))
    }

    private fun editNode(guid: String, f: (VNode) -> VNode) {
        if (tree.isRoot(guid)) throw CoreException("root_locked", "roots are locked")
        val n = tree.nodes[guid] ?: throw CoreException("stale", "gone")
        tree = tree.copy(nodes = tree.nodes + (guid to f(n)))
        status = status.copy(localRev = status.localRev + 1)
    }

    override suspend fun rename(guid: String, title: String) {
        record("rename $guid $title")
        editNode(guid) { it.copy(title = title) }
    }

    override suspend fun setUrl(guid: String, url: String) {
        record("setUrl $guid $url")
        editNode(guid) { it.copy(url = url) }
    }

    override suspend fun move(guid: String, parent: String, position: Position) {
        record("move $guid $parent $position")
        val node = tree.nodes[guid] ?: throw CoreException("stale", "gone")
        detach(guid)
        insert(parent, position, node)
    }

    override suspend fun delete(guid: String) {
        record("delete $guid")
        if (tree.isRoot(guid)) throw CoreException("root_locked", "roots are locked")
        detach(guid)
        fun drop(g: String): List<String> = listOf(g) + tree.nodes[g]?.children.orEmpty().flatMap(::drop)
        tree = tree.copy(nodes = tree.nodes - drop(guid).toSet())
    }

    private fun detach(guid: String) {
        val parent = tree.parents[guid] ?: return
        val p = tree.nodes.getValue(parent)
        tree = tree.copy(nodes = tree.nodes + (parent to p.copy(children = p.children.orEmpty() - guid)))
    }

    override suspend fun countSubtree(guid: String): SubtreeCount {
        fun walk(g: String): List<VNode> = tree.children(g).flatMap { listOf(it) + walk(it.guid) }
        val all = walk(guid)
        return SubtreeCount(all.count { !it.isFolder }, all.count { it.isFolder })
    }

    override suspend fun sync(): SyncResult {
        record("sync")
        return syncResults.removeFirstOrNull() ?: SyncResult(SyncStatus.OK)
    }

    override suspend fun confirmDeletions(): SyncResult {
        record("confirmDeletions")
        return syncResults.removeFirstOrNull() ?: SyncResult(SyncStatus.OK)
    }

    override suspend fun resolveRollback(choice: Recovery): SyncResult {
        record("resolveRollback ${choice.wire}")
        return syncResults.removeFirstOrNull() ?: SyncResult(SyncStatus.OK)
    }

    override fun parseSyncId(text: String): String {
        val t = text.uppercase().filter { it.isLetterOrDigit() }.removePrefix("BS1")
        if (t.length != 28) throw CoreException("invalid_format", "SyncID must have 28 characters")
        if (t.endsWith("ZZ")) throw CoreException("invalid_checksum", "SyncID has a typo")
        return "BS1-" + t.chunked(4).joinToString("-")
    }

    companion object {
        fun emptyTree() = Tree(
            format = 1, seq = 0, writtenBy = "", writtenAt = 0.0,
            nodes = Roots.ALL.associateWith { VNode(it, NodeKind.FOLDER, it, children = emptyList()) },
        )
    }
}
