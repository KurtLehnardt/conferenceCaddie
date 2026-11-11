package app.conferencecaddie.shared.people

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import app.conferencecaddie.shared.db.CaddieDatabase
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.withContext
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem

/**
 * The people records' own SQLite file, one key-value table (`records`), through the same bundled
 * driver as [CaddieDatabase] but apart from it.
 *
 * The records live apart because they must have the device credential's lifetime. The credential
 * never leaves the phone (the iOS Keychain item is "this device only"; Android excludes everything
 * from backup and transfer), while the iOS main database is in iCloud and device backups. Records
 * restored to a new phone without their credential would say a profile is on the server that this
 * phone cannot reach, and the next "make me visible" would create a second profile and orphan the
 * first. They also name other attendees (people met, watched, blocked), which have no place in a
 * backup. So each platform keeps this file where nothing backs it up: on iOS a directory marked
 * excluded from backup, on Android the no-backup directory (IosCore, AndroidCore). It is not the
 * cache database either, which is thrown away whenever it is cleared or broken.
 *
 * Like [CaddieDatabase.openLazily], the file opens at the first [get] or [set], on a dispatcher of
 * its own that never runs two statements at once and never on the caller's thread, and opening never
 * fails:
 *
 * - A corrupt file (SQLite's SQLITE_CORRUPT or SQLITE_NOTADB) is deleted with its journals and
 *   created again, empty. Nothing is kept for a later look: the file names other people.
 * - A file from a newer version of the app is left for that version, and any other failure (no
 *   space, no permission, iOS data protection before the first unlock) leaves the file alone too:
 *   none of them says the records are gone, so deleting them would lose a profile's records over a
 *   passing problem. This launch then keeps the records in memory, and [inMemory] says so, so the
 *   people features create nothing on the server that the next launch would lose track of.
 */
class PeopleDatabase private constructor(private val opener: () -> Opened) : PeopleKeyValue {
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO.limitedParallelism(1)

    @kotlin.concurrent.Volatile
    private var opened: Opened? = null

    private class Opened(val connection: SQLiteConnection, val inMemory: Boolean)

    private fun connection(): SQLiteConnection = (opened ?: opener().also { opened = it }).connection

    private suspend fun <T> run(block: (SQLiteConnection) -> T): T = withContext(dispatcher) { block(connection()) }

    override suspend fun get(key: String): String? = run { c ->
        c.prepare("SELECT value FROM records WHERE key = ?").use { s ->
            s.bindText(1, key)
            if (s.step()) s.getText(0) else null
        }
    }

    override suspend fun set(key: String, value: String?) = run { c ->
        if (value == null) {
            c.prepare("DELETE FROM records WHERE key = ?").use { s ->
                s.bindText(1, key)
                s.step()
            }
        } else {
            c.prepare("INSERT INTO records (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").use { s ->
                s.bindText(1, key)
                s.bindText(2, value)
                s.step()
            }
        }
        Unit
    }

    /** True once the file could not be opened and this launch keeps the records in memory. */
    override val inMemory: Boolean get() = opened?.inMemory == true

    /** Closes the connection after every statement already queued has run. */
    suspend fun closeWhenIdle() = withContext(dispatcher) { opened?.connection?.close() }

    companion object {
        /** The schema, one migration per version, as [CaddieDatabase.MIGRATIONS]. */
        val MIGRATIONS: List<List<String>> = listOf(
            listOf("CREATE TABLE records (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)"),
        )

        private const val MEMORY = ":memory:"

        /** The store at [path] (":memory:" for a test), opened at its first statement (see the class comment). */
        fun openLazily(path: String): PeopleDatabase = PeopleDatabase {
            val connection = try {
                openFile(path)
            } catch (e: Throwable) {
                val replaced = if (!CaddieDatabase.isNewerSchema(e) && CaddieDatabase.isCorruptFile(e) && deleteFiles(path)) {
                    try {
                        openFile(path)
                    } catch (_: Throwable) {
                        null
                    }
                } else {
                    null
                }
                replaced ?: return@PeopleDatabase Opened(openFile(MEMORY), inMemory = true)
            }
            Opened(connection, inMemory = false)
        }

        private fun openFile(path: String): SQLiteConnection {
            if (path != MEMORY) Path(path).parent?.let { if (!SystemFileSystem.exists(it)) SystemFileSystem.createDirectories(it) }
            val connection = BundledSQLiteDriver().open(path)
            try {
                CaddieDatabase.migrate(connection, "main", MIGRATIONS)
            } catch (e: Throwable) {
                connection.close()
                throw e
            }
            return connection
        }

        /** Deletes the file at [path] and its journals; true when the path is free for a new file. */
        private fun deleteFiles(path: String): Boolean {
            if (path == MEMORY) return false
            for (suffix in listOf("-journal", "-wal", "-shm", "")) {
                try {
                    SystemFileSystem.delete(Path(path + suffix), mustExist = false)
                } catch (_: Exception) {
                    // A journal left behind would be read by the new file, so the path is not free.
                    return false
                }
            }
            return true
        }
    }
}
