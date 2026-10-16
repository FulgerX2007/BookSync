package io.booksync.android.search

import io.booksync.android.core.NodeKind
import io.booksync.android.core.Roots
import io.booksync.android.core.Tree
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.text.Normalizer
import java.util.Locale

/**
 * Substring search over the local bookmarks, a port of the extension's
 * src/bookmarks/search.ts so both clients find the same things.
 *
 * Every query word must occur in the title or the URL; matching ignores case
 * and accents. Results whose title holds every word come first, then the
 * rest, each group in tree order. Folders match by title only; roots never.
 */
data class SearchResult(
    val guid: String,
    val kind: NodeKind,
    val title: String,
    val url: String?,
    /** Titles of the folders above the node, root first. */
    val path: List<String>,
    /** Every query word occurs in the title (these rank first). */
    val allInTitle: Boolean,
)

class BookmarkSearch(private val tree: Tree, private val rootTitle: (String) -> String = { tree.node(it)?.title.orEmpty() }) {
    private class Entry(val guid: String, val kind: NodeKind, val title: String, val url: String?, val title_: String, val url_: String)

    /** Normalized strings, computed once per tree load, in tree order. */
    private val entries: List<Entry> = buildList {
        fun walk(g: String) {
            val n = tree.node(g) ?: return
            if (!tree.isRoot(g)) {
                val url = if (n.kind == NodeKind.BOOKMARK) n.url else null
                add(Entry(g, n.kind, n.title, url, normalize(n.title), url?.let { normalize(decodeUri(it)) }.orEmpty()))
            }
            n.children?.forEach(::walk)
        }
        Roots.ALL.forEach(::walk)
    }

    fun search(query: String, limit: Int = Int.MAX_VALUE, kinds: Set<NodeKind> = NodeKind.entries.toSet()): List<SearchResult> {
        val words = normalize(query).split(WHITESPACE).filter { it.isNotEmpty() }
        if (words.isEmpty() || limit <= 0) return emptyList()
        val first = ArrayList<Entry>()
        val rest = ArrayList<Entry>()
        for (e in entries) {
            if (e.kind !in kinds) continue
            var allInTitle = true
            var matches = true
            for (w in words) {
                if (e.title_.contains(w)) continue
                allInTitle = false
                if (!e.url_.contains(w)) {
                    matches = false
                    break
                }
            }
            if (!matches) continue
            (if (allInTitle) first else rest) += e
            if (first.size >= limit) break
        }
        val out = first.take(limit).mapTo(ArrayList()) { result(it, true) }
        for (e in rest) {
            if (out.size >= limit) break
            out += result(e, false)
        }
        return out
    }

    private fun result(e: Entry, allInTitle: Boolean) = SearchResult(e.guid, e.kind, e.title, e.url, path(e.guid), allInTitle)

    private fun path(guid: String): List<String> {
        val out = ArrayDeque<String>()
        var p = tree.parents[guid]
        val seen = HashSet<String>()
        while (p != null && seen.add(p)) {
            out.addFirst(if (tree.isRoot(p)) rootTitle(p) else tree.node(p)?.title.orEmpty())
            p = tree.parents[p]
        }
        return out
    }

    companion object {
        private val MARKS = Regex("\\p{M}")
        private val WHITESPACE = Regex("\\s+")

        /** Case- and accent-insensitive form: compatibility-decomposed, marks removed, lower case. */
        fun normalize(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFKD).replace(MARKS, "").lowercase(Locale.ROOT)

        /** decodeURI's reserved set: escapes of these stay encoded. */
        private const val RESERVED = ";/?:@&=+$,#"

        /**
         * JavaScript's decodeURI, so a percent-encoded URL (/caf%C3%A9) matches
         * what the user types (café). Malformed input is returned unchanged.
         */
        fun decodeUri(url: String): String {
            if ('%' !in url) return url
            val out = StringBuilder(url.length)
            var i = 0
            try {
                while (i < url.length) {
                    val c = url[i]
                    if (c != '%') {
                        out.append(c)
                        i++
                        continue
                    }
                    val first = hexByte(url, i)
                    if (first < 0x80) {
                        val ch = first.toChar()
                        if (ch in RESERVED) out.append(url, i, i + 3) else out.append(ch)
                        i += 3
                        continue
                    }
                    // A multi-byte UTF-8 sequence: all its bytes must be escaped too.
                    val n = when {
                        first and 0xE0 == 0xC0 -> 2
                        first and 0xF0 == 0xE0 -> 3
                        first and 0xF8 == 0xF0 -> 4
                        else -> throw IllegalArgumentException("bad lead byte")
                    }
                    val bytes = ByteArrayOutputStream(n)
                    for (k in 0 until n) {
                        if (url.getOrNull(i) != '%') throw IllegalArgumentException("truncated sequence")
                        bytes.write(hexByte(url, i))
                        i += 3
                    }
                    out.append(
                        Charsets.UTF_8.newDecoder()
                            .onMalformedInput(CodingErrorAction.REPORT)
                            .onUnmappableCharacter(CodingErrorAction.REPORT)
                            .decode(ByteBuffer.wrap(bytes.toByteArray())),
                    )
                }
            } catch (_: IllegalArgumentException) {
                return url
            } catch (_: CharacterCodingException) {
                return url
            }
            return out.toString()
        }

        private fun hexByte(s: String, i: Int): Int {
            if (i + 3 > s.length) throw IllegalArgumentException("truncated escape")
            val hi = Character.digit(s[i + 1], 16)
            val lo = Character.digit(s[i + 2], 16)
            if (hi < 0 || lo < 0) throw IllegalArgumentException("bad escape")
            return hi * 16 + lo
        }
    }
}
