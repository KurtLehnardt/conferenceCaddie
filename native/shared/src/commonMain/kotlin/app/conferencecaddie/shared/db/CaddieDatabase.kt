package app.conferencecaddie.shared.db

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import androidx.sqlite.execSQL
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.bundle.Topic
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.withContext

/**
 * The app's SQLite database, through the bundled driver of androidx.sqlite, which compiles SQLite
 * with FTS5 on every platform. It holds:
 *
 * - `settings`: small key-value pairs (the chosen backend, the selected conference, the cached
 *   capabilities document and the "has served a document" mark per backend base).
 * - `http_cache`: the last good body and ETag of `conferences.json` per URL, for offline use and
 *   `If-None-Match`.
 * - `installed_bundle` and the talk search index (`talk_row` and the FTS5 table `talk_fts`), one
 *   set per scope. A scope is a backend base and a conference slug, so two backends never share
 *   state.
 * - `interested`: the talks the person marked, per scope.
 *
 * The schema version is SQLite's `user_version`; [MIGRATIONS] move it forward one step at a time,
 * each in its own transaction. A connection is not thread-safe, so every statement runs on one
 * dispatcher that never runs two blocks at once.
 */
class CaddieDatabase private constructor(private val connection: SQLiteConnection) {
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO.limitedParallelism(1)

    /** Runs [block] with the connection, alone. */
    suspend fun <T> run(block: (SQLiteConnection) -> T): T = withContext(dispatcher) { block(connection) }

    /** Runs [block] in a transaction that commits when it returns and rolls back when it throws. */
    suspend fun <T> transaction(block: (SQLiteConnection) -> T): T = run { c -> c.inTransaction(block) }

    fun close() = connection.close()

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

    suspend fun setInterested(scope: String, talkId: String, interested: Boolean, nowMs: Long) = run { c ->
        if (interested) {
            c.prepare("INSERT OR IGNORE INTO interested (scope, talk_id, added_at) VALUES (?, ?, ?)").use { s ->
                s.bindText(1, scope)
                s.bindText(2, talkId)
                s.bindLong(3, nowMs)
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

    companion object {
        /**
         * BM25 column weights, in table order: title, abstract, speakers, taglines, topics, track,
         * room. Title counts double, as on the server (`title^2`); abstract, speakers and taglines
         * count once, as there. The server does not search topics, track and room as text; here they
         * count half, so a word of a talk's track or topic finds it before semantic search exists.
         */
        const val WEIGHTS = "2.0, 1.0, 1.0, 1.0, 0.5, 0.5, 0.5"

        /**
         * The schema, one migration per version: MIGRATIONS[0] takes an empty database to version 1.
         * Add a migration at the end; never change one that has shipped.
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
        )

        /** Opens (creating if needed) the database at [path] and migrates it. ":memory:" is a test database. */
        fun open(path: String): CaddieDatabase {
            val connection = BundledSQLiteDriver().open(path)
            try {
                connection.execSQL("PRAGMA foreign_keys = ON")
                if (path != ":memory:") connection.execSQL("PRAGMA journal_mode = WAL")
                migrate(connection)
            } catch (e: Throwable) {
                connection.close()
                throw e
            }
            return CaddieDatabase(connection)
        }

        /** The schema version of a connection. */
        fun version(connection: SQLiteConnection): Int =
            connection.prepare("PRAGMA user_version").use { s -> if (s.step()) s.getLong(0).toInt() else 0 }

        internal fun migrate(connection: SQLiteConnection) {
            val current = version(connection)
            require(current <= MIGRATIONS.size) {
                "The database is from a newer version of the app (schema $current, this app knows ${MIGRATIONS.size})."
            }
            for (v in current until MIGRATIONS.size) {
                connection.inTransaction { c ->
                    MIGRATIONS[v].forEach { c.execSQL(it) }
                    c.execSQL("PRAGMA user_version = ${v + 1}")
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
