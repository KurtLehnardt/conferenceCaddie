package app.conferencecaddie.shared.people

import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import androidx.sqlite.execSQL
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.db.CaddieDatabase
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.TimeZone
import kotlinx.io.buffered
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory

/**
 * The people records' own file ([PeopleDatabase]): it keeps what is written across launches, a
 * corrupt file is replaced, and anything else that keeps it from opening leaves it alone and keeps
 * this launch's records in memory, which the controller then treats like a database in memory.
 */
class PeopleDatabaseTest {
    private val dir = Path(SystemTemporaryDirectory, "caddie-people-${Random.nextLong().toULong()}").also { SystemFileSystem.createDirectories(it) }
    private val path = Path(dir, "people", "people.db").toString()
    private val key = "people:v1:https://a.example#profile"

    @AfterTest
    fun cleanUp() = deleteTree(dir)

    private fun deleteTree(p: Path) {
        if (SystemFileSystem.metadataOrNull(p)?.isDirectory == true) SystemFileSystem.list(p).forEach { deleteTree(it) }
        SystemFileSystem.delete(p, mustExist = false)
    }

    private fun write(bytes: ByteArray) = SystemFileSystem.sink(Path(path)).buffered().use { it.write(bytes) }

    @Test
    fun valuesRoundTripAndOutliveTheConnection() = runTest {
        val db = PeopleDatabase.openLazily(path)
        assertNull(db.get(key))
        db.set(key, """{"name":"Ada"}""")
        db.set("$key-other", "x")
        db.set(key, """{"name":"Ada B"}""")
        db.set("$key-other", null)
        assertFalse(db.inMemory)
        db.closeWhenIdle()

        val again = PeopleDatabase.openLazily(path)
        assertEquals("""{"name":"Ada B"}""", again.get(key))
        assertNull(again.get("$key-other"), "a null value removes the key")
        assertFalse(again.inMemory)
        again.closeWhenIdle()
    }

    @Test
    fun theFileIsCreatedInItsOwnDirectoryOnlyAtTheFirstStatement() = runTest {
        val db = PeopleDatabase.openLazily(path)
        assertFalse(SystemFileSystem.exists(Path(path)), "nothing is opened before the first statement")
        assertFalse(db.inMemory)
        db.set(key, "v")
        assertTrue(SystemFileSystem.exists(Path(path)))
        db.closeWhenIdle()
        // One table of its own, nothing of the main database's.
        BundledSQLiteDriver().open(path).apply {
            val tables = prepare("SELECT name FROM sqlite_master WHERE type = 'table'").use { s -> buildList { while (s.step()) add(s.getText(0)) } }
            assertEquals(listOf("records"), tables)
            assertEquals(PeopleDatabase.MIGRATIONS.size, CaddieDatabase.version(this))
            close()
        }
    }

    @Test
    fun aCorruptFileIsReplacedByAnEmptyOne() = runTest {
        SystemFileSystem.createDirectories(Path(path).parent!!)
        write(ByteArray(4096) { 'x'.code.toByte() })
        val db = PeopleDatabase.openLazily(path)
        assertNull(db.get(key))
        assertFalse(db.inMemory, "a new file replaced it, so what is written now is kept")
        db.set(key, "after")
        db.closeWhenIdle()
        assertEquals(listOf("people.db"), SystemFileSystem.list(Path(path).parent!!).map { it.name }.filter { !it.endsWith("-journal") })
        val again = PeopleDatabase.openLazily(path)
        assertEquals("after", again.get(key))
        again.closeWhenIdle()
    }

    @Test
    fun aFileFromANewerAppIsLeftForItAndThisLaunchKeepsTheRecordsInMemory() = runTest {
        PeopleDatabase.openLazily(path).apply {
            set(key, "kept")
            closeWhenIdle()
        }
        BundledSQLiteDriver().open(path).apply {
            execSQL("PRAGMA user_version = 99")
            close()
        }
        val db = PeopleDatabase.openLazily(path)
        assertNull(db.get(key))
        assertTrue(db.inMemory)
        db.set(key, "this launch only")
        assertEquals("this launch only", db.get(key))
        db.closeWhenIdle()
        BundledSQLiteDriver().open(path).apply {
            assertEquals(99, CaddieDatabase.version(this))
            val value = prepare("SELECT value FROM records WHERE key = ?").use { s ->
                s.bindText(1, key)
                if (s.step()) s.getText(0) else null
            }
            assertEquals("kept", value, "the newer app's records are untouched")
            close()
        }
    }

    @Test
    fun aFileThatCannotBeOpenedIsLeftAloneAndThisLaunchKeepsTheRecordsInMemory() = runTest {
        // A directory where the file should be: SQLite cannot open it, but nothing says it is
        // corrupt, so nothing is deleted (as for a file iOS keeps locked before the first unlock).
        SystemFileSystem.createDirectories(Path(path))
        SystemFileSystem.sink(Path(path, "marker")).buffered().use { it.write(byteArrayOf(1)) }
        val db = PeopleDatabase.openLazily(path)
        db.set(key, "v")
        assertTrue(db.inMemory)
        assertEquals("v", db.get(key))
        db.closeWhenIdle()
        assertTrue(SystemFileSystem.exists(Path(path, "marker")))
    }

    @Test
    fun recordsInMemoryCreateNoProfileOnTheServer() = runTest {
        // The main database opened (storageInMemory is false), but the people file did not.
        val h = PeopleHarness(this)
        val records = object : PeopleKeyValue by MapKeyValue() {
            override val inMemory = true
        }
        val controller = PeopleController(records, h.http, PeopleServices(h.secure), backgroundScope, allowLocalHttp = false, clock = h.clock, timeZone = TimeZone.UTC)
        controller.updateContext(h.context())
        runCurrent()
        controller.updateProfile { it.copy(displayName = "Caddie Native Test A") }
        runCurrent()
        assertEquals(PeopleError.RECORDS_IN_MEMORY_MESSAGE, controller.setOpenToMeet(true))
        runCurrent()
        assertTrue(h.sent("PUT", "/api/people/profile").isEmpty(), "nothing is sent")
        assertFalse(controller.state.value.visibility.openToMeet)
        controller.close()
    }
}
