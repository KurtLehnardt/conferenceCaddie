package app.conferencecaddie.shared.db

import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.fixtures.Fixtures
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.test.runTest

class DatabaseTest {
    private val database = CaddieDatabase.open(":memory:")
    private val bundle = TalkBundle.decode(Fixtures.HASH, Fixtures.files.getValue("bundle.json"))!!

    @AfterTest
    fun close() = database.close()

    @Test
    fun migrationsReachTheLatestVersion() = runTest {
        assertEquals(CaddieDatabase.MIGRATIONS.size, database.run { CaddieDatabase.version(it) })
    }

    @Test
    fun settingsRoundTrip() = runTest {
        assertNull(database.setting("backend"))
        database.setSetting("backend", "https://a.example")
        database.setSetting("backend", "https://b.example")
        assertEquals("https://b.example", database.setting("backend"))
        database.setSetting("backend", null)
        assertNull(database.setting("backend"))
    }

    @Test
    fun interestedIsKeptPerScope() = runTest {
        database.setInterested("a\nconf", "conf:1", true, 1)
        database.setInterested("a\nconf", "conf:2", true, 2)
        database.setInterested("a\nconf", "conf:1", true, 3)
        database.setInterested("b\nconf", "conf:9", true, 4)
        assertEquals(listOf("conf:1", "conf:2"), database.interested("a\nconf"))
        database.setInterested("a\nconf", "conf:1", false, 5)
        assertEquals(listOf("conf:2"), database.interested("a\nconf"))
        assertEquals(listOf("conf:9"), database.interested("b\nconf"))
    }

    @Test
    fun installingReplacesTheScopesIndexOnly() = runTest {
        database.install("a\nx", bundle, 1)
        database.install("b\nx", bundle, 1)
        database.install("a\nx", bundle, 2)
        assertEquals(Fixtures.HASH, database.installedBundle("a\nx"))
        val (sets, ranked) = database.match("a\nx", listOf("\"kubernetes\""), "\"kubernetes\"")
        assertEquals(setOf(Fixtures.B, Fixtures.C), sets.single())
        assertEquals(2, ranked.size, "no duplicate rows after a reinstall, and the other scope stays apart")
        database.clearBundles()
        assertNull(database.installedBundle("a\nx"))
        assertEquals(emptyList(), database.match("b\nx", emptyList(), "\"kubernetes\"").second)
    }

    @Test
    fun ftsUsesThePorterStemmerAndFoldsDiacritics() = runTest {
        database.install("s", bundle, 1)
        assertEquals(listOf(Fixtures.C), database.match("s", emptyList(), "\"scheduler\"").second)
        assertEquals(listOf(Fixtures.A), database.match("s", emptyList(), "\"sécurité\" OR \"securing\"").second)
    }
}
