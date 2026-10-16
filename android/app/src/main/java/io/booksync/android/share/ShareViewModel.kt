package io.booksync.android.share

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.booksync.android.core.BookSyncCore
import io.booksync.android.core.CoreException
import io.booksync.android.core.Position
import io.booksync.android.core.Roots
import io.booksync.android.ui.bookmarks.FolderOption
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.net.URI

/** The first http(s) URL in shared text, without trailing punctuation, or null. */
fun extractUrl(text: String?): String? {
    val m = URL.find(text ?: return null) ?: return null
    return m.value.trimEnd(*TRAILING)
}

private val URL = Regex("""https?://[^\s<>"]+""", RegexOption.IGNORE_CASE)
private val TRAILING = charArrayOf('.', ',', ';', ':', '!', '?', ')', ']', '}', '\'', '"')

/** The subject if the sharing app gave one, else the URL's host. */
fun shareTitle(subject: String?, url: String): String =
    subject?.trim()?.takeIf { it.isNotEmpty() } ?: runCatching { URI(url).host?.removePrefix("www.") }.getOrNull() ?: url

data class ShareState(
    val loading: Boolean = true,
    /** No account on this device: explain and offer to open the app. */
    val signedOut: Boolean = false,
    val url: String? = null,
    val title: String = "",
    val folders: List<FolderOption> = emptyList(),
    val folder: String = Roots.MOBILE,
    val saving: Boolean = false,
    val error: String? = null,
    val done: Boolean = false,
)

/** Saves a shared page as a bookmark; the sync happens afterwards (worker or app). */
class ShareViewModel(
    private val core: BookSyncCore,
    private val lastFolder: () -> String?,
    private val rememberFolder: (String) -> Unit,
    /** Schedules the upload. */
    private val onSaved: () -> Unit,
) : ViewModel() {
    private val _state = MutableStateFlow(ShareState())
    val state: StateFlow<ShareState> = _state.asStateFlow()

    fun load(text: String?, subject: String?, rootTitle: (String) -> String) {
        viewModelScope.launch {
            val url = extractUrl(text)
            if (url == null) {
                _state.update { it.copy(loading = false, error = "no_url") }
                return@launch
            }
            val status = core.status()
            if (!status.hasAccount) {
                _state.update { it.copy(loading = false, signedOut = true, url = url) }
                return@launch
            }
            val tree = core.tree()
            val folders = buildList {
                fun walk(g: String, depth: Int) {
                    val n = tree.node(g) ?: return
                    if (!n.isFolder) return
                    add(FolderOption(g, if (tree.isRoot(g)) rootTitle(g) else n.title, depth))
                    n.children?.forEach { walk(it, depth + 1) }
                }
                Roots.ALL.forEach { walk(it, 0) }
            }
            val preferred = lastFolder()?.takeIf { f -> folders.any { it.guid == f } } ?: Roots.MOBILE
            _state.update { it.copy(loading = false, url = url, title = shareTitle(subject, url), folders = folders, folder = preferred) }
        }
    }

    fun setTitle(t: String) = _state.update { it.copy(title = t) }
    fun setFolder(g: String) = _state.update { it.copy(folder = g) }

    fun save() {
        val s = _state.value
        val url = s.url ?: return
        if (s.saving) return
        _state.update { it.copy(saving = true, error = null) }
        viewModelScope.launch {
            try {
                core.addBookmark(s.folder, Position.End, s.title.trim().ifEmpty { url }, url)
                rememberFolder(s.folder)
                onSaved()
                _state.update { it.copy(saving = false, done = true) }
            } catch (e: CoreException) {
                _state.update { it.copy(saving = false, error = e.code) }
            }
        }
    }
}
