package app.conferencecaddie.shared.core

import android.content.Context
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.net.KtorHttp
import app.conferencecaddie.shared.people.PeopleController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.io.files.Path

/** The one [CaddieCore] and [PeopleController] of the process, so they outlive activity re-creation. */
object AndroidCore {
    @Volatile private var instance: CaddieCore? = null
    @Volatile private var peopleInstance: PeopleController? = null
    private lateinit var database: CaddieDatabase
    private lateinit var http: KtorHttp
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

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
            database = CaddieDatabase.openLazily(dbFile.absolutePath, app.getDatabasePath("caddie-cache.db").absolutePath)
            http = KtorHttp()
            CaddieCore(
                database = database,
                files = BundleFiles(Path(bundles.absolutePath)),
                http = http,
                scope = scope,
                allowLocalHttp = allowLocalHttp,
            ).also {
                instance = it
                it.start()
            }
        }
    }

    /**
     * The process's people features, created on first use next to the core (the same database and
     * HTTP client) and bound to its state. [services] are the platform's; they are used by the first
     * call only, which every later call returns.
     */
    fun people(context: Context, services: PeopleServices, allowLocalHttp: Boolean): PeopleController = peopleInstance ?: synchronized(this) {
        peopleInstance ?: run {
            val core = get(context, allowLocalHttp)
            PeopleController.create(database, http, services, scope, allowLocalHttp).also {
                it.bind(core.state)
                peopleInstance = it
            }
        }
    }
}
