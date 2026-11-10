package app.conferencecaddie.shared.core

import android.content.Context
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.net.KtorHttp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.io.files.Path

/** The one [CaddieCore] of the process, so it outlives activity re-creation. */
object AndroidCore {
    @Volatile private var instance: CaddieCore? = null

    /**
     * The process's core, created on first use. The database and its cache database live in the
     * app's database directory and the bundles in its files directory; all are excluded from backup
     * and device transfer by the manifest's backup rules. Nothing is read here: the database opens
     * on its own I/O thread at the first statement, so the main thread never waits for it, and a
     * database that cannot be opened is replaced rather than crashing every start
     * ([CaddieDatabase.openLazily]).
     */
    fun get(context: Context, allowLocalHttp: Boolean): CaddieCore = instance ?: synchronized(this) {
        instance ?: run {
            val app = context.applicationContext
            val dbFile = app.getDatabasePath("caddie.db")
            val bundles = app.filesDir.resolve("bundles")
            CaddieCore(
                database = CaddieDatabase.openLazily(dbFile.absolutePath, app.getDatabasePath("caddie-cache.db").absolutePath),
                files = BundleFiles(Path(bundles.absolutePath)),
                http = KtorHttp(),
                scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
                allowLocalHttp = allowLocalHttp,
            ).also {
                instance = it
                it.start()
            }
        }
    }
}
