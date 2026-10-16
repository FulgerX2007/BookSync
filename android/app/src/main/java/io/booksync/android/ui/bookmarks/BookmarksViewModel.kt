package io.booksync.android.ui.bookmarks

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.booksync.android.core.BookSyncCore
import io.booksync.android.core.CoreException
import io.booksync.android.core.Position
import io.booksync.android.core.Roots
import io.booksync.android.core.Tree
import io.booksync.android.core.VNode
import io.booksync.android.search.BookmarkSearch
import io.booksync.android.search.SearchResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.net.URI

/** What a dialog or sheet is open for. */
sealed interface BrowserDialog {
    data class Actions(val node: VNode) : BrowserDialog
    data class AddBookmark(val parent: String) : BrowserDialog
    data class AddFolder(val parent: String) : BrowserDialog
    data class Rename(val node: VNode) : BrowserDialog
    data class EditUrl(val node: VNode) : BrowserDialog
    data class Move(val node: VNode) : BrowserDialog
    data class ConfirmDelete(val node: VNode, val bookmarks: Int, val folders: Int) : BrowserDialog
}

/** A folder in the move picker, indented by depth. */
data class FolderOption(val guid: String, val title: String, val depth: Int)

data class BrowserState(
    val tree: Tree? = null,
    /** The open folder; null shows the list of roots. */
    val folder: String? = null,
    val searching: Boolean = false,
    val query: String = "",
    val results: List<SearchResult> = emptyList(),
    val dialog: BrowserDialog? = null,
    /** An error or notice code to show once. */
    val message: String? = null,
) {
    val path: List<VNode> get() = folder?.let { tree?.path(it) }.orEmpty()
    val items: List<VNode> get() = folder?.let { tree?.children(it) }.orEmpty()
}

/**
 * The bookmark browser. All edits go through the core (which locks roots and
 * validates), then the tree is re-read; nothing is edited in the UI's copy.
 */
class BookmarksViewModel(
    private val core: BookSyncCore,
    /** Called after every successful edit, so a sync can follow. */
    private val onEdited: () -> Unit = {},
) : ViewModel() {
    private val _state = MutableStateFlow(BrowserState())
    val state: StateFlow<BrowserState> = _state.asStateFlow()
    private var index: BookmarkSearch? = null

    /** Display titles for roots; the UI sets localized strings. */
    var rootTitle: (String) -> String = { it }

    init {
        refresh()
    }

    /** Re-reads the tree (after an edit here, or a sync that changed it). */
    fun refresh() {
        viewModelScope.launch {
            val tree = try {
                core.tree()
            } catch (e: CoreException) {
                _state.update { it.copy(message = e.code) }
                return@launch
            }
            index = BookmarkSearch(tree) { rootTitle(it) }
            _state.update { s ->
                // The open folder may have been deleted by a sync: fall back to the roots.
                val folder = s.folder?.let { f -> if (tree.node(f) != null) f else null }
                s.copy(tree = tree, folder = folder, results = search(s.query))
            }
        }
    }

    fun open(folder: String) = _state.update { it.copy(folder = folder, searching = false, query = "", results = emptyList()) }

    /** Goes up one level; false at the list of roots (the caller then leaves the screen). */
    fun up(): Boolean {
        val s = _state.value
        if (s.searching) {
            _state.update { it.copy(searching = false, query = "", results = emptyList()) }
            return true
        }
        val folder = s.folder ?: return false
        _state.update { it.copy(folder = if (folder in Roots.ALL) null else s.tree?.parents?.get(folder)) }
        return true
    }

    fun startSearch() = _state.update { it.copy(searching = true) }

    fun setQuery(q: String) = _state.update { it.copy(query = q, results = search(q)) }

    private fun search(q: String): List<SearchResult> = index?.search(q, limit = 200).orEmpty()

    /**
     * Activates a bookmark: returns the URL to open, or null (and a message)
     * when the app should not hand it to a browser (javascript:, data:, …).
     */
    fun urlToOpen(url: String?): String? {
        if (url != null && isWebUrl(url)) return url
        _state.update { it.copy(message = "cannot_open") }
        return null
    }

    /** A folder result navigates into it; a bookmark result returns its URL. */
    fun openResult(r: SearchResult): String? {
        if (r.kind == io.booksync.android.core.NodeKind.FOLDER) {
            open(r.guid)
            return null
        }
        return urlToOpen(r.url)
    }

    fun dismissMessage() = _state.update { it.copy(message = null) }
    fun dismissDialog() = _state.update { it.copy(dialog = null) }

    /** Long press: roots have no actions. */
    fun showActions(node: VNode) {
        if (node.guid in Roots.ALL) return
        _state.update { it.copy(dialog = BrowserDialog.Actions(node)) }
    }

    fun show(dialog: BrowserDialog) = _state.update { it.copy(dialog = dialog) }

    fun requestDelete(node: VNode) {
        viewModelScope.launch {
            val count = core.countSubtree(node.guid)
            _state.update { it.copy(dialog = BrowserDialog.ConfirmDelete(node, count.bookmarks, count.folders)) }
        }
    }

    fun addBookmark(parent: String, title: String, url: String) = edit { core.addBookmark(parent, Position.End, title.trim().ifEmpty { url.trim() }, url) }
    fun addFolder(parent: String, title: String) = edit { core.addFolder(parent, Position.End, title.trim()) }
    fun rename(guid: String, title: String) = edit { core.rename(guid, title.trim()) }
    fun setUrl(guid: String, url: String) = edit { core.setUrl(guid, url) }
    fun move(guid: String, parent: String) = edit { core.move(guid, parent, Position.End) }
    fun delete(guid: String) = edit { core.delete(guid) }

    private fun edit(action: suspend () -> Any) {
        viewModelScope.launch {
            try {
                action()
                _state.update { it.copy(dialog = null) }
                onEdited()
            } catch (e: CoreException) {
                // Keep the dialog open on input errors so the user can fix them.
                _state.update { it.copy(message = e.code, dialog = if (e.code == "invalid_url") it.dialog else null) }
            }
            refresh()
        }
    }

    /** Folders a node may move into: not itself, not inside itself. */
    fun moveTargets(node: VNode): List<FolderOption> {
        val tree = _state.value.tree ?: return emptyList()
        val out = ArrayList<FolderOption>()
        fun walk(g: String, depth: Int) {
            if (g == node.guid) return
            val n = tree.node(g) ?: return
            if (!n.isFolder) return
            out += FolderOption(g, if (g in Roots.ALL) rootTitle(g) else n.title, depth)
            n.children?.forEach { walk(it, depth + 1) }
        }
        Roots.ALL.forEach { walk(it, 0) }
        return out
    }

    companion object {
        fun isWebUrl(url: String): Boolean {
            val scheme = runCatching { URI(url.trim()).scheme }.getOrNull()?.lowercase()
            return scheme == "http" || scheme == "https"
        }

        /** The host to show under a bookmark's title. */
        fun displayHost(url: String?): String {
            if (url.isNullOrEmpty()) return ""
            return runCatching { URI(url).host }.getOrNull()?.removePrefix("www.") ?: url
        }
    }
}
