package app.conferencecaddie.shared.db

import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.fixtures.Fixtures
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import androidx.sqlite.execSQL
import app.conferencecaddie.shared.bundle.InterestedTalk
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.io.buffered
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.test.runTest

class DatabaseTest {
    private val database = CaddieDatabase.open(":memory:")
    private val bundle = TalkBundle.decode(Fixtures.HASH, Fixtures.files.getValue("bundle.json"))!!
    private val dir = Path(SystemTemporaryDirectory, "caddie-db-${Random.nextLong().toULong()}").also { SystemFileSystem.createDirectories(it) }
    private val path = Path(dir, "caddie.db").toString()

    @AfterTest
    fun close() {
        database.close()
        for (child in SystemFileSystem.list(dir)) SystemFileSystem.delete(child, mustExist = false)
        SystemFileSystem.delete(dir, mustExist = false)
    }

    private fun write(path: String, bytes: ByteArray) = SystemFileSystem.sink(Path(path)).buffered().use { it.write(bytes) }

    @Test
    fun aDatabaseFromANewerAppIsLeftForItAndThisLaunchRunsInMemory() = runTest {
        CaddieDatabase.open(path).apply {
            setSetting("backend", "https://a.example")
            run { it.execSQL("PRAGMA user_version = 99") }
            close()
        }
        val e = assertFailsWith<IllegalArgumentException> { CaddieDatabase.open(path) }
        assertTrue(CaddieDatabase.isNewerSchema(e))

        val lazy = CaddieDatabase.openLazily(path)
        assertTrue(lazy.wasReset(), "the person is told once")
        assertFalse(lazy.wasReset())
        assertTrue(lazy.runsInMemory(), "marks made now are not kept")
        assertNull(lazy.setting("backend"))
        lazy.setSetting("backend", "https://b.example")
        assertEquals("https://b.example", lazy.setting("backend"))
        lazy.close()
        assertTrue(unreadable().isEmpty(), "nothing is moved aside")
        // The newer app's file is untouched, so an upgrade opens it again.
        BundledSQLiteDriver().open(path).apply {
            assertEquals(99, CaddieDatabase.version(this))
            close()
        }
        val again = CaddieDatabase.openLazily(path)
        assertTrue(again.runsInMemory(), "every launch of this older app runs in memory")
        again.close()
    }

    // The moved-aside main files (their -wal and -shm, if any, go with them).
    private fun unreadable(): List<String> = SystemFileSystem.list(dir).map { it.name }
        .filter { it.startsWith("caddie.db.unreadable-") && !it.endsWith("-wal") && !it.endsWith("-shm") }.sorted()

    @Test
    fun aCorruptDatabaseIsMovedAsideAndReplaced() = runTest {
        write(path, ByteArray(4096) { 'x'.code.toByte() })
        val lazy = CaddieDatabase.openLazily(path, nowMs = { 1_000 })
        assertTrue(lazy.wasReset())
        assertFalse(lazy.runsInMemory(), "a new file replaced it")
        lazy.setInterested("s", "conf:1", true, 1)
        assertEquals(listOf("conf:1"), lazy.interested("s"))
        lazy.close()
        assertEquals(listOf("caddie.db.unreadable-1000"), unreadable())
        val again = CaddieDatabase.openLazily(path)
        assertFalse(again.wasReset(), "the next start opens the new database normally")
        assertEquals(listOf("conf:1"), again.interested("s"))
        again.close()
    }

    @Test
    fun onlyTheNewestThreeUnreadableCopiesAreKept() = runTest {
        for (t in 1L..5L) {
            write(path, ByteArray(4096) { t.toByte() })
            SystemFileSystem.delete(Path("$path-wal"), mustExist = false)
            SystemFileSystem.delete(Path("$path-shm"), mustExist = false)
            val db = CaddieDatabase.openLazily(path, nowMs = { t * 1_000 })
            assertTrue(db.wasReset())
            db.close()
        }
        assertEquals(
            listOf("caddie.db.unreadable-3000", "caddie.db.unreadable-4000", "caddie.db.unreadable-5000"),
            unreadable(),
        )
    }

    @Test
    fun aCorruptCacheIsReplacedWithoutANotice() = runTest {
        CaddieDatabase.open(path).apply {
            setInterested("s", "conf:1", true, 1)
            close()
        }
        write(CaddieDatabase.defaultCachePath(path), ByteArray(4096) { 'x'.code.toByte() })
        assertFailsWith<Exception> { CaddieDatabase.open(path) }
        val lazy = CaddieDatabase.openLazily(path)
        assertFalse(lazy.wasReset(), "only re-downloadable data was lost")
        assertEquals(listOf("conf:1"), lazy.interested("s"))
        lazy.install("s", bundle, 1)
        assertEquals(Fixtures.HASH, lazy.installedBundle("s"))
        lazy.close()
    }

    @Test
    fun version1MovesTheCacheOutAndKeepsTheMarks() = runTest {
        // A database as phase 2a's first build left it: one file, schema version 1.
        BundledSQLiteDriver().open(path).apply {
            CaddieDatabase.MIGRATIONS[0].forEach { execSQL(it) }
            execSQL("PRAGMA user_version = 1")
            execSQL("INSERT INTO interested (scope, talk_id, added_at) VALUES ('s', 'conf:1', 1)")
            execSQL("INSERT INTO http_cache (url, body, etag, fetched_at) VALUES ('u', x'00', NULL, 1)")
            execSQL("INSERT INTO installed_bundle (scope, content_hash, installed_at) VALUES ('s', 'h', 1)")
            close()
        }
        val db = CaddieDatabase.open(path)
        assertEquals(CaddieDatabase.MIGRATIONS.size, db.run { CaddieDatabase.version(it) })
        assertEquals(CaddieDatabase.CACHE_MIGRATIONS.size, db.run { CaddieDatabase.version(it, "cache") })
        assertEquals(listOf("conf:1"), db.interested("s"))
        assertEquals(emptyMap(), db.interestedSnapshots("s"), "an old mark has no copy yet")
        assertNull(db.cachedResponse("u"), "the cache starts empty in its own file")
        assertNull(db.installedBundle("s"))
        db.close()
        assertTrue(SystemFileSystem.exists(Path(CaddieDatabase.defaultCachePath(path))))
    }

    @Test
    fun aMarkKeepsACopyOfItsTalk() = runTest {
        val a = bundle.talksById.getValue(Fixtures.A)
        database.setInterested("s", Fixtures.A, true, 1, InterestedTalk.from(a.copy(title = "Old title")))
        database.setInterested("s", Fixtures.B, true, 2)
        assertEquals("Old title", database.interestedSnapshots("s")[Fixtures.A]?.title)
        assertEquals(setOf(Fixtures.A), database.interestedSnapshots("s").keys, "a mark without a copy has none")
        database.setInterested("s", Fixtures.A, true, 3)
        assertEquals("Old title", database.interestedSnapshots("s")[Fixtures.A]?.title, "marking again without a copy keeps it")
        database.refreshInterested("s", bundle)
        val copies = database.interestedSnapshots("s")
        assertEquals(a.title, copies[Fixtures.A]?.title, "the bundle brings the copy up to date")
        assertEquals(bundle.talksById.getValue(Fixtures.B).title, copies[Fixtures.B]?.title, "and fills in a missing one")
        assertEquals(a.copy(abstract = "", speakerTaglines = a.speakers.map { null }, tags = emptyList(), topics = emptyList(), level = null, sponsor = false), copies[Fixtures.A]?.toTalk())
        assertEquals(listOf(Fixtures.A, Fixtures.B), database.interested("s"))
    }

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
