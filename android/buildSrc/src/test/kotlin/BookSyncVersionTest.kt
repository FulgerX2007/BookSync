import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BookSyncVersionTest {
    @Test
    fun releaseAndRcCodes() {
        assertEquals(1_020_399, BookSyncVersion.code("1.2.3"))
        assertEquals(1_020_301, BookSyncVersion.code("1.2.3-rc.1"))
        assertEquals(990_099, BookSyncVersion.code("0.99.0"))
        assertTrue(BookSyncVersion.code("1.2.3-rc.1") < BookSyncVersion.code("1.2.3"))
        assertTrue(BookSyncVersion.code("1.2.3") < BookSyncVersion.code("1.2.4-rc.1"))
    }

    @Test
    fun nonTagBuildsAreDev() {
        for (bad in listOf(null, "", "dev", "1.2", "1.2.3-beta.1", "1.100.0", "1.2.3-rc.0", "1.2.3-rc.100", "0.0.0-rc.1")) {
            assertEquals(bad.toString(), 1, BookSyncVersion.code(BookSyncVersion.name(bad)))
            assertEquals(bad.toString(), BookSyncVersion.DEV_NAME, BookSyncVersion.name(bad))
        }
        assertEquals("1.2.3", BookSyncVersion.name("v1.2.3"))
        assertEquals("1.2.3-rc.2", BookSyncVersion.name(" 1.2.3-rc.2 "))
    }
}
