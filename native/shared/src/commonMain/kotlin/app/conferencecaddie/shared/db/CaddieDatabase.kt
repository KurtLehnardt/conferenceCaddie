package app.conferencecaddie.shared.db

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import androidx.sqlite.execSQL
import app.conferencecaddie.shared.bundle.InterestedTalk
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.bundle.Topic
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlin.time.Clock
import kotlinx.coroutines.withContext
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem

/**
 * The app's SQLite databases, through the bundled driver of androidx.sqlite, which compiles SQLite
 * with FTS5 on every platform. There are two files on one connection:
 *
 * - The main database, which holds what the person made and what cannot be fetched again:
 *   - `settings`: small key-value pairs (the chosen backend, the selected conference, the cached
 *     capabilities document and the "has served a document" mark per backend base).
 *   - `interested`: the talks the person marked, per scope, each with a copy of its public schedule
 *     fields ([InterestedTalk]) so it can be shown after a newer bundle drops it.
 * - The cache database, attached as `cache`, which holds only what can be downloaded again, so the
 *   platforms can keep it out of backups (iOS) and a broken one can simply be replaced:
 *   - `http_cache`: the last good body and ETag of `conferences.json` per URL, for offline use and
 *     `If-None-Match`.
 *   - `installed_bundle` and the talk search index (`talk_row` and the FTS5 table `talk_fts`), one
 *     set per scope.
 *
 * A scope is a backend base and a conference slug, so two backends never share state.
 *
 * Each file's schema version is its `user_version`; [MIGRATIONS] and [CACHE_MIGRATIONS] move them
 * forward one step at a time, each in its own transaction. A connection is not thread-safe, so every
 * statement runs on one dispatcher that never runs two blocks at once.
 *
 * [openLazily] opens the files on that dispatcher at the first statement, never on the caller's
 * thread, and never fails. A corrupt main database is moved aside to `{path}.unreadable-{time}`
 * (the newest three are kept) and replaced by an empty one. A main database from a newer version of
 * the app (after a downgrade, or a restored backup) is left where it is, so that version opens it
 * again after an upgrade, and this launch runs in memory, as it does after any other failure (no
 * space, no permission). [wasReset] says once that the stored data could not be used, and
 * [runsInMemory] whether marks made now will be lost. A broken cache database is deleted and
 * created again.
 */
class CaddieDatabase private constructor(private val opener: () -> Opened) {
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO.limitedParallelism(1)
    private var opened: Opened? = null
    private var resetReported = false

    private class Opened(val connection: SQLiteConnection, val reset: Boolean, val inMemory: Boolean = false)

    private fun connection(): SQLiteConnection = (opened ?: opener().also { opened = it }).connection

    /** Runs [block] with the connection, alone. */
    suspend fun <T> run(block: (SQLiteConnection) -> T): T = withContext(dispatcher) { block(connection()) }

    /** Runs [block] in a transaction that commits when it returns and rolls back when it throws. */
    suspend fun <T> transaction(block: (SQLiteConnection) -> T): T = run { c -> c.inTransaction(block) }

    /**
     * True, once, when the stored main database could not be opened and an empty one replaced it.
     * It opens the database if that has not happened yet.
     */
    suspend fun wasReset(): Boolean = withContext(dispatcher) {
        connection()
        val reset = opened?.reset == true && !resetReported
        resetReported = true
        reset
    }

    /** True when the main database runs in memory because the stored one could not be opened. */
    suspend fun runsInMemory(): Boolean = withContext(dispatcher) {
        connection()
        opened?.inMemory == true
    }

    /** Closes the connection. Call it only once nothing runs on the database any more. */
    fun close() {
        opened?.connection?.close()
    }

    /** Closes the connection after every statement already queued has run. */
    suspend fun closeWhenIdle() = withContext(dispatcher) { close() }

    // ---------------------------------------------------------------------------------------------
    // Settings

    suspend fun setting(key: String): String? = run { c ->
        c.prepare("SELECT value FROM settings WHERE key = ?").use { s ->
            s.bindText(1, key)
            if (s.step()) s.getText(0) else null
        }
    }

    suspend fun setSetting(key: String, value: String?) = run { c ->
        if (value == null) {
            c.prepare("DELETE FROM settings WHERE key = ?").use { s ->
                s.bindText(1, key)
                s.step()
            }
        } else {
            c.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").use { s ->
                s.bindText(1, key)
                s.bindText(2, value)
                s.step()
            }
        }
        Unit
    }

    // ---------------------------------------------------------------------------------------------
    // HTTP cache

    class CachedResponse(val body: ByteArray, val etag: String?, val fetchedAtMs: Long)

    suspend fun cachedResponse(url: String): CachedResponse? = run { c ->
        c.prepare("SELECT body, etag, fetched_at FROM http_cache WHERE url = ?").use { s ->
            s.bindText(1, url)
            if (s.step()) CachedResponse(s.getBlob(0), if (s.isNull(1)) null else s.getText(1), s.getLong(2)) else null
        }
    }

    suspend fun storeResponse(url: String, body: ByteArray, etag: String?, fetchedAtMs: Long) = run { c ->
        c.prepare(
            "INSERT INTO http_cache (url, body, etag, fetched_at) VALUES (?, ?, ?, ?) " +
                "ON CONFLICT(url) DO UPDATE SET body = excluded.body, etag = excluded.etag, fetched_at = excluded.fetched_at",
        ).use { s ->
            s.bindText(1, url)
            s.bindBlob(2, body)
            if (etag == null) s.bindNull(3) else s.bindText(3, etag)
            s.bindLong(4, fetchedAtMs)
            s.step()
        }
        Unit
    }

    /** When the cached response for [url] was fetched or confirmed, without reading its body. */
    suspend fun cachedFetchedAt(url: String): Long? = run { c ->
        c.prepare("SELECT fetched_at FROM http_cache WHERE url = ?").use { s ->
            s.bindText(1, url)
            if (s.step()) s.getLong(0) else null
        }
    }

    suspend fun touchResponse(url: String, fetchedAtMs: Long) = run { c ->
        c.prepare("UPDATE http_cache SET fetched_at = ? WHERE url = ?").use { s ->
            s.bindLong(1, fetchedAtMs)
            s.bindText(2, url)
            s.step()
        }
        Unit
    }

    // ---------------------------------------------------------------------------------------------
    // Installed bundles and the search index

    /** The content hash of the bundle installed for [scope], or null. */
    suspend fun installedBundle(scope: String): String? = run { c ->
        c.prepare("SELECT content_hash FROM installed_bundle WHERE scope = ?").use { s ->
            s.bindText(1, scope)
            if (s.step()) s.getText(0) else null
        }
    }

    /** Every installed bundle as scope to content hash. */
    suspend fun installedBundles(): Map<String, String> = run { c ->
        c.prepare("SELECT scope, content_hash FROM installed_bundle").use { s ->
            buildMap { while (s.step()) put(s.getText(0), s.getText(1)) }
        }
    }

    /**
     * Makes [bundle] the installed bundle of [scope] and rebuilds the scope's search index from it,
     * in one transaction: until it commits, searches see the previous bundle; if it fails, they
     * keep seeing it.
     */
    suspend fun install(scope: String, bundle: TalkBundle, nowMs: Long) = transaction { c ->
        deleteIndex(c, scope)
        val labels = bundle.topicsById
        c.prepare("INSERT INTO talk_row (scope, talk_id) VALUES (?, ?)").use { row ->
            c.prepare(
                "INSERT INTO talk_fts (rowid, title, abstract, speakers, taglines, topics, track, room) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ).use { fts ->
                for (talk in bundle.talks) {
                    row.reset()
                    row.bindText(1, scope)
                    row.bindText(2, talk.talkId)
                    row.step()
                    val rowId = c.lastInsertRowId()
                    fts.reset()
                    fts.bindLong(1, rowId)
                    fts.bindText(2, talk.title)
                    fts.bindText(3, talk.abstract)
                    fts.bindText(4, talk.speakers.joinToString("\n"))
                    fts.bindText(5, talk.speakerTaglines.filterNotNull().joinToString("\n"))
                    fts.bindText(6, topicText(talk, labels))
                    fts.bindText(7, talk.track ?: "")
                    fts.bindText(8, talk.room ?: "")
                    fts.step()
                }
            }
        }
        c.prepare(
            "INSERT INTO installed_bundle (scope, content_hash, installed_at) VALUES (?, ?, ?) " +
                "ON CONFLICT(scope) DO UPDATE SET content_hash = excluded.content_hash, installed_at = excluded.installed_at",
        ).use { s ->
            s.bindText(1, scope)
            s.bindText(2, bundle.contentHash)
            s.bindLong(3, nowMs)
            s.step()
        }
        Unit
    }

    /** Forgets every installed bundle and search index; the interested lists and settings stay. */
    suspend fun clearBundles() = transaction { c ->
        c.execSQL("DELETE FROM talk_fts")
        c.execSQL("DELETE FROM talk_row")
        c.execSQL("DELETE FROM installed_bundle")
        c.execSQL("DELETE FROM http_cache")
    }

    /**
     * For each FTS5 query in [queries], the talk ids of [scope] it matches; and for [ranked] (when
     * not null), the matching talk ids ordered by BM25 with the column weights of [WEIGHTS].
     */
    suspend fun match(scope: String, queries: List<String>, ranked: String?): Pair<List<Set<String>>, List<String>> = run { c ->
        val sets = queries.map { q ->
            c.prepare(
                "SELECT r.talk_id FROM talk_fts JOIN talk_row r ON r.rowid = talk_fts.rowid WHERE talk_fts MATCH ? AND r.scope = ?",
            ).use { s ->
                s.bindText(1, q)
                s.bindText(2, scope)
                buildSet { while (s.step()) add(s.getText(0)) }
            }
        }
        val order = if (ranked == null) {
            emptyList()
        } else {
            c.prepare(
                "SELECT r.talk_id FROM talk_fts JOIN talk_row r ON r.rowid = talk_fts.rowid " +
                    "WHERE talk_fts MATCH ? AND r.scope = ? ORDER BY bm25(talk_fts, $WEIGHTS), r.talk_id",
            ).use { s ->
                s.bindText(1, ranked)
                s.bindText(2, scope)
                buildList { while (s.step()) add(s.getText(0)) }
            }
        }
        sets to order
    }

    // ---------------------------------------------------------------------------------------------
    // Interested

    suspend fun interested(scope: String): List<String> = run { c ->
        c.prepare("SELECT talk_id FROM interested WHERE scope = ? ORDER BY added_at, talk_id").use { s ->
            s.bindText(1, scope)
            buildList { while (s.step()) add(s.getText(0)) }
        }
    }

    /** The copies kept of [scope]'s marked talks, by talk id. Talks marked without a copy are left out. */
    suspend fun interestedSnapshots(scope: String): Map<String, InterestedTalk> = run { c ->
        c.prepare("SELECT talk_id, snapshot FROM interested WHERE scope = ? AND snapshot IS NOT NULL").use { s ->
            s.bindText(1, scope)
            buildMap {
                while (s.step()) InterestedTalk.fromJson(s.getText(1))?.takeIf { it.talkId == s.getText(0) }?.let { put(it.talkId, it) }
            }
        }
    }

    /**
     * Marks or unmarks [talkId] in [scope]. A mark keeps [snapshot] when one is given; marking a
     * talk that is marked already keeps its date and only refreshes the copy.
     */
    suspend fun setInterested(scope: String, talkId: String, interested: Boolean, nowMs: Long, snapshot: InterestedTalk? = null) = run { c ->
        if (interested) {
            c.prepare(
                "INSERT INTO interested (scope, talk_id, added_at, snapshot) VALUES (?, ?, ?, ?) " +
                    "ON CONFLICT(scope, talk_id) DO UPDATE SET snapshot = coalesce(excluded.snapshot, interested.snapshot)",
            ).use { s ->
                s.bindText(1, scope)
                s.bindText(2, talkId)
                s.bindLong(3, nowMs)
                if (snapshot == null) s.bindNull(4) else s.bindText(4, snapshot.toJson())
                s.step()
            }
        } else {
            c.prepare("DELETE FROM interested WHERE scope = ? AND talk_id = ?").use { s ->
                s.bindText(1, scope)
                s.bindText(2, talkId)
                s.step()
            }
        }
        Unit
    }

    /**
     * Brings the copies of [scope]'s marked talks up to date with [bundle], for the talks it still
     * holds; the copies of talks it dropped stay as they were.
     */
    suspend fun refreshInterested(scope: String, bundle: TalkBundle) = transaction { c ->
        val ids = c.prepare("SELECT talk_id, snapshot FROM interested WHERE scope = ?").use { s ->
            s.bindText(1, scope)
            buildMap { while (s.step()) put(s.getText(0), if (s.isNull(1)) null else s.getText(1)) }
        }
        c.prepare("UPDATE interested SET snapshot = ? WHERE scope = ? AND talk_id = ?").use { s ->
            for ((id, old) in ids) {
                val talk = bundle.talksById[id] ?: continue
                val copy = InterestedTalk.from(talk).toJson()
                if (copy == old) continue
                s.reset()
                s.bindText(1, copy)
                s.bindText(2, scope)
                s.bindText(3, id)
                s.step()
            }
        }
    }

    companion object {
        /**
         * BM25 column weights, in table order: title, abstract, speakers, taglines, topics, track,
         * room. Title counts double, as on the server (`title^2`); abstract, speakers and taglines
         * count once, as there. The server does not search topics, track and room as text; here they
         * count half, so a word of a talk's track or topic finds it before semantic search exists.
         */
        const val WEIGHTS = "2.0, 1.0, 1.0, 1.0, 0.5, 0.5, 0.5"

        /**
         * The main database's schema, one migration per version: MIGRATIONS[0] takes an empty
         * database to version 1. Add a migration at the end; never change one that has shipped.
         *
         * Version 2 moves everything that can be downloaded again to the cache database (the old
         * tables are dropped; the bundles are downloaded again) and keeps a copy of each marked talk.
         */
        val MIGRATIONS: List<List<String>> = listOf(
            listOf(
                "CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
                "CREATE TABLE http_cache (url TEXT PRIMARY KEY NOT NULL, body BLOB NOT NULL, etag TEXT, fetched_at INTEGER NOT NULL)",
                "CREATE TABLE installed_bundle (scope TEXT PRIMARY KEY NOT NULL, content_hash TEXT NOT NULL, installed_at INTEGER NOT NULL)",
                "CREATE TABLE talk_row (rowid INTEGER PRIMARY KEY, scope TEXT NOT NULL, talk_id TEXT NOT NULL, UNIQUE (scope, talk_id))",
                "CREATE VIRTUAL TABLE talk_fts USING fts5(title, abstract, speakers, taglines, topics, track, room, " +
                    "tokenize = 'porter unicode61 remove_diacritics 2')",
                "CREATE TABLE interested (scope TEXT NOT NULL, talk_id TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (scope, talk_id))",
            ),
            listOf(
                "DROP TABLE main.talk_fts",
                "DROP TABLE main.talk_row",
                "DROP TABLE main.installed_bundle",
                "DROP TABLE main.http_cache",
                "ALTER TABLE main.interested ADD COLUMN snapshot TEXT",
            ),
        )

        /** The cache database's schema, attached as `cache`; the same rules as [MIGRATIONS]. */
        val CACHE_MIGRATIONS: List<List<String>> = listOf(
            listOf(
                "CREATE TABLE cache.http_cache (url TEXT PRIMARY KEY NOT NULL, body BLOB NOT NULL, etag TEXT, fetched_at INTEGER NOT NULL)",
                "CREATE TABLE cache.installed_bundle (scope TEXT PRIMARY KEY NOT NULL, content_hash TEXT NOT NULL, installed_at INTEGER NOT NULL)",
                "CREATE TABLE cache.talk_row (rowid INTEGER PRIMARY KEY, scope TEXT NOT NULL, talk_id TEXT NOT NULL, UNIQUE (scope, talk_id))",
                "CREATE VIRTUAL TABLE cache.talk_fts USING fts5(title, abstract, speakers, taglines, topics, track, room, " +
                    "tokenize = 'porter unicode61 remove_diacritics 2')",
            ),
        )

        private const val MEMORY = ":memory:"

        /**
         * Opens (creating if needed) the database at [path], with its cache database at [cachePath]
         * (by default next to it, `{name}-cache.db`), and migrates both. ":memory:" is a test
         * database. It throws when either cannot be opened or migrated; the apps use [openLazily].
         */
        fun open(path: String, cachePath: String = defaultCachePath(path)): CaddieDatabase {
            val connection = openMain(path)
            try {
                attachCache(connection, cachePath)
            } catch (e: Throwable) {
                connection.close()
                throw e
            }
            return CaddieDatabase { Opened(connection, reset = false) }.also { it.connection() }
        }

        /**
         * A database that opens [path] and [cachePath] at its first statement, on its own
         * dispatcher, and recovers instead of failing (see the class comment). If even an empty
         * database cannot be created there, it runs in memory for this launch.
         */
        fun openLazily(
            path: String,
            cachePath: String = defaultCachePath(path),
            nowMs: () -> Long = { Clock.System.now().toEpochMilliseconds() },
        ): CaddieDatabase = CaddieDatabase {
            var reset = false
            var inMemory = false
            val connection = try {
                openMain(path)
            } catch (e: Throwable) {
                reset = true
                // A database from a newer app is kept where it is, for that app to open again; a
                // corrupt file is moved aside; any other failure leaves the file alone. In every case
                // but a successful move, this launch runs in memory.
                val replaced = if (!isNewerSchema(e) && isCorruptFile(e) && moveAside(path, nowMs())) {
                    try {
                        openMain(path)
                    } catch (_: Throwable) {
                        null
                    }
                } else {
                    null
                }
                replaced ?: openMain(MEMORY).also { inMemory = true }
            }
            try {
                attachCache(connection, cachePath)
            } catch (_: Throwable) {
                try {
                    connection.execSQL("DETACH DATABASE cache")
                } catch (_: Throwable) {
                    // It was never attached.
                }
                deleteFiles(cachePath)
                try {
                    attachCache(connection, cachePath)
                } catch (_: Throwable) {
                    attachCache(connection, MEMORY)
                }
            }
            Opened(connection, reset, inMemory)
        }

        fun defaultCachePath(path: String): String = if (path == MEMORY) MEMORY else path.removeSuffix(".db") + "-cache.db"

        /** The schema version of a connection's main database, or of [schema]. */
        fun version(connection: SQLiteConnection, schema: String = "main"): Int =
            connection.prepare("PRAGMA $schema.user_version").use { s -> if (s.step()) s.getLong(0).toInt() else 0 }

        private fun openMain(path: String): SQLiteConnection {
            if (path != MEMORY) Path(path).parent?.let { if (!SystemFileSystem.exists(it)) SystemFileSystem.createDirectories(it) }
            val connection = BundledSQLiteDriver().open(path)
            try {
                connection.execSQL("PRAGMA foreign_keys = ON")
                if (path != MEMORY) connection.execSQL("PRAGMA journal_mode = WAL")
                migrate(connection, "main", MIGRATIONS)
            } catch (e: Throwable) {
                connection.close()
                throw e
            }
            return connection
        }

        private fun attachCache(connection: SQLiteConnection, cachePath: String) {
            if (cachePath != MEMORY) Path(cachePath).parent?.let { if (!SystemFileSystem.exists(it)) SystemFileSystem.createDirectories(it) }
            connection.prepare("ATTACH DATABASE ? AS cache").use { s ->
                s.bindText(1, cachePath)
                s.step()
            }
            if (cachePath != MEMORY) connection.execSQL("PRAGMA cache.journal_mode = WAL")
            migrate(connection, "cache", CACHE_MIGRATIONS)
        }

        internal fun migrate(connection: SQLiteConnection, schema: String, migrations: List<List<String>>) {
            val current = version(connection, schema)
            require(current <= migrations.size) {
                "The $schema database is from a newer version of the app (schema $current, this app knows ${migrations.size})."
            }
            for (v in current until migrations.size) {
                connection.inTransaction { c ->
                    migrations[v].forEach { c.execSQL(it) }
                    c.execSQL("PRAGMA $schema.user_version = ${v + 1}")
                }
            }
        }

        /** True for a database whose schema is from a newer version of the app. */
        internal fun isNewerSchema(e: Throwable): Boolean =
            e is IllegalArgumentException && e.message?.contains("newer version of the app") == true

        /** True for SQLite's SQLITE_CORRUPT (11) and SQLITE_NOTADB (26): the file itself is unusable. */
        internal fun isCorruptFile(e: Throwable): Boolean {
            val m = e.message ?: return false
            return Regex("""\b(?:code|Error code):? ?(?:11|26)\b""", RegexOption.IGNORE_CASE).containsMatchIn(m) ||
                m.contains("not a database", ignoreCase = true) || m.contains("malformed", ignoreCase = true)
        }

        /** How many sets of moved-aside files are kept next to the database. */
        const val KEEP_UNREADABLE = 3

        private const val UNREADABLE = ".unreadable-"

        /**
         * Moves the database files at [path] to `{path}.unreadable-{nowMs}`, keeping them for a later
         * look, and deletes all but the newest [KEEP_UNREADABLE] such sets. True when the path is
         * free for a new database; the main file is never deleted.
         */
        internal fun moveAside(path: String, nowMs: Long): Boolean {
            if (path == MEMORY) return false
            val stamp = "$path$UNREADABLE$nowMs"
            for (suffix in listOf("", "-wal", "-shm")) {
                val from = Path(path + suffix)
                try {
                    if (SystemFileSystem.exists(from)) SystemFileSystem.atomicMove(from, Path(stamp + suffix))
                } catch (_: Exception) {
                    // The main file must move. A journal that cannot move must not stay either, or a
                    // new database at the path would read it; if it cannot be deleted, the path is
                    // not free and the launch runs in memory.
                    if (suffix.isEmpty()) return false
                    try {
                        SystemFileSystem.delete(from, mustExist = false)
                    } catch (_: Exception) {
                        return false
                    }
                }
            }
            pruneUnreadable(path)
            return true
        }

        private fun pruneUnreadable(path: String) {
            try {
                val file = Path(path)
                val dir = file.parent ?: return
                val prefix = file.name + UNREADABLE
                val sets = SystemFileSystem.list(dir).map { it.name }.filter { it.startsWith(prefix) }
                    .groupBy { it.removePrefix(prefix).substringBefore('-').toLongOrNull() ?: 0L }
                for (old in sets.keys.sortedDescending().drop(KEEP_UNREADABLE)) {
                    sets.getValue(old).forEach { SystemFileSystem.delete(Path(dir, it), mustExist = false) }
                }
            } catch (_: Exception) {
                // Old copies stay; they are only kept for a later look.
            }
        }

        private fun deleteFiles(path: String) {
            if (path == MEMORY) return
            for (suffix in listOf("", "-wal", "-shm")) {
                try {
                    SystemFileSystem.delete(Path(path + suffix), mustExist = false)
                } catch (_: Exception) {
                    // Opening again will fail, and the cache runs in memory.
                }
            }
        }

        private fun deleteIndex(c: SQLiteConnection, scope: String) {
            c.prepare("DELETE FROM talk_fts WHERE rowid IN (SELECT rowid FROM talk_row WHERE scope = ?)").use { s ->
                s.bindText(1, scope)
                s.step()
            }
            c.prepare("DELETE FROM talk_row WHERE scope = ?").use { s ->
                s.bindText(1, scope)
                s.step()
            }
        }

        private fun topicText(talk: Talk, labels: Map<String, Topic>): String =
            talk.topics.mapNotNull { labels[it] }.flatMap { listOf(it.label) + it.aliases }.joinToString("\n")

        private fun SQLiteConnection.lastInsertRowId(): Long =
            prepare("SELECT last_insert_rowid()").use { s -> s.step(); s.getLong(0) }

        private fun <T> SQLiteConnection.inTransaction(block: (SQLiteConnection) -> T): T {
            execSQL("BEGIN IMMEDIATE")
            try {
                val result = block(this)
                execSQL("COMMIT")
                return result
            } catch (e: Throwable) {
                try {
                    execSQL("ROLLBACK")
                } catch (_: Throwable) {
                    // The original failure matters more than a failed rollback.
                }
                throw e
            }
        }
    }
}
