package io.booksync.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Decodes the JSON the Go core emits (fixtures written by mobile/core_test.go -update). */
class ModelsJsonTest {
    private fun fixture(name: String): String =
        requireNotNull(javaClass.getResource("/fixtures/$name")) { "missing fixture $name" }.readText()

    private inline fun <reified T> decode(name: String): T = coreJson.decodeFromString(fixture(name))

    @Test
    fun tree() {
        val t = decode<Tree>("tree.json")
        assertEquals(8, t.nodes.size)
        val folder = t.node("folder000001")!!
        assertTrue(folder.isFolder)
        assertEquals("News ☕", folder.title)
        assertEquals(listOf("bkmark000001", "empty0000001"), folder.children)
        assertEquals("https://example.com/?a=1&b=2", t.node("bkmark000001")!!.url)
        assertEquals("", t.node("bkmark000002")!!.url)
        assertEquals(emptyList<String>(), t.node("empty0000001")!!.children)
        assertEquals(listOf(Roots.TOOLBAR, "folder000001", "bkmark000001"), t.path("bkmark000001").map { it.guid })
        assertEquals(listOf("bkmark000001", "empty0000001"), t.children("folder000001").map { it.guid })
        assertTrue(t.isRoot(Roots.MOBILE))
    }

    @Test
    fun statuses() {
        val out = decode<Status>("status-signed-out.json")
        assertFalse(out.signedIn || out.needsReauth || out.hasAccount)

        val signedIn = decode<Status>("status-signed-in.json")
        assertTrue(signedIn.signedIn && signedIn.hasAccount)
        assertEquals("alice", signedIn.username)
        assertEquals(SyncStatus.OK, signedIn.syncStatus)
        assertEquals(4L, signedIn.localRev)

        val attention = decode<Status>("status-attention.json")
        assertTrue(attention.needsReauth && attention.hasAccount)
        assertEquals(Pending(7, 25, 0), attention.pendingConfirmation)
        assertEquals(Rollback(7, 3, 9), attention.rollback)
        assertEquals("state_unreadable", attention.notice)
    }

    @Test
    fun syncResults() {
        assertEquals(SyncResult(SyncStatus.OK, uploaded = true, version = 8, changed = true), decode<SyncResult>("sync-ok.json"))
        assertEquals(Pending(7, 25, 0), decode<SyncResult>("sync-needs-confirmation.json").pending)
        val rb = decode<SyncResult>("sync-rollback.json")
        assertEquals(SyncStatus.ROLLBACK_DETECTED, rb.status)
        assertEquals(3L, rb.remoteSeq)
        assertNull(decode<SyncResult>("sync-rollback-emptied.json").remoteSeq)
        val err = decode<SyncResult>("sync-error.json")
        assertEquals("rate_limited", err.code)
        assertEquals(7000L, err.retryAfterMs)
        assertEquals(SyncStatus.BUSY, decode<SyncResult>("sync-busy.json").status)
    }

    @Test
    fun kitCountAndErrors() {
        assertEquals("booksync-emergency-kit-alice.txt", decode<Kit>("kit.json").fileName)
        assertEquals(SubtreeCount(2, 1), decode<SubtreeCount>("subtree-count.json"))
        val e = CoreException.from(Exception(fixture("error.json").trim()))
        assertEquals("invalid_credentials", e.code)
        assertEquals("username, password or SyncID is incorrect", e.message)
    }

    @Test
    fun nonCoreErrorsAreInternal() {
        val e = CoreException.from(IllegalStateException("boom"))
        assertEquals("internal", e.code)
        assertEquals("boom", e.message)
        val same = CoreException("x", "y")
        assertTrue(CoreException.from(same) === same)
    }

    @Test
    fun passwordsAreNormalizedToNfc() {
        val decomposed = "pässwörd"
        assertEquals("pässwörd", nfc(decomposed))
        assertEquals("", Position.First.after)
        assertEquals("", Position.End.after)
        assertEquals("g1", Position.After("g1").after)
    }
}
