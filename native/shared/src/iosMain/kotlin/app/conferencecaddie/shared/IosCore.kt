package app.conferencecaddie.shared.core

import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.net.KtorHttp
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleDatabase
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.io.files.Path
import platform.Foundation.NSApplicationSupportDirectory
import platform.Foundation.NSFileManager
import platform.Foundation.NSNotificationCenter
import platform.Foundation.NSNumber
import platform.Foundation.NSOperationQueue
import platform.Foundation.NSURLIsExcludedFromBackupKey
import platform.Foundation.NSUserDomainMask
import platform.UIKit.UIApplicationDidReceiveMemoryWarningNotification

/** The one [CaddieCore] and [PeopleController] of the app. */
object IosCore {
    private var instance: CaddieCore? = null
    private var peopleInstance: PeopleController? = null
    private lateinit var database: CaddieDatabase
    private lateinit var peoplePath: String
    private lateinit var http: KtorHttp
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * The app's core, created on first use, on the main thread. Everything lives in Application
     * Support under `caddie/`:
     *
     * - `caddie.db`, the main database: settings and the marked talks, which stay in iCloud and
     *   device backups.
     * - `cache/cache.db`, the cache database (the conference lists, the installed bundles and the
     *   search index), and `bundles/`, the bundle files. Both can be downloaded again, so their
     *   directories are excluded from backups; after a restore the app downloads them again.
     * - `people/people.db`, the people records ([PeopleDatabase], opened by [people]). Its directory
     *   is excluded from backups because the records belong with the device credential, a Keychain
     *   item that never leaves this phone: restored without it, they would make the next "make me
     *   visible" create a second profile. They also name other attendees. After a restore the
     *   people features start empty, as on a new phone.
     *
     * The databases open on their own I/O thread at the first statement, and one that cannot be
     * opened is replaced rather than crashing every start ([CaddieDatabase.openLazily],
     * [PeopleDatabase.openLazily]).
     */
    @OptIn(ExperimentalForeignApi::class)
    fun get(allowLocalHttp: Boolean): CaddieCore = instance ?: run {
        val fm = NSFileManager.defaultManager
        val support = fm.URLForDirectory(NSApplicationSupportDirectory, NSUserDomainMask, null, true, null)
            ?: error("Application Support is not available")
        val dir = support.URLByAppendingPathComponent("caddie", isDirectory = true)!!
        val bundles = dir.URLByAppendingPathComponent("bundles", isDirectory = true)!!
        val cache = dir.URLByAppendingPathComponent("cache", isDirectory = true)!!
        val people = dir.URLByAppendingPathComponent("people", isDirectory = true)!!
        for (excluded in listOf(bundles, cache, people)) {
            fm.createDirectoryAtURL(excluded, withIntermediateDirectories = true, attributes = null, error = null)
            excluded.setResourceValue(NSNumber(bool = true), forKey = NSURLIsExcludedFromBackupKey, error = null)
        }
        val dbPath = dir.URLByAppendingPathComponent("caddie.db")!!.path!!
        val cachePath = cache.URLByAppendingPathComponent("cache.db")!!.path!!
        database = CaddieDatabase.openLazily(dbPath, cachePath)
        peoplePath = people.URLByAppendingPathComponent("people.db")!!.path!!
        http = KtorHttp()
        CaddieCore(
            database = database,
            files = BundleFiles(Path(bundles.path!!)),
            http = http,
            scope = scope,
            allowLocalHttp = allowLocalHttp,
        ).also {
            instance = it
            it.start()
            // iOS warns an app before it ends it for memory. The query model (about 60 MB once
            // loaded) is given back then, as on Android; the next text search loads it again.
            NSNotificationCenter.defaultCenter.addObserverForName(
                UIApplicationDidReceiveMemoryWarningNotification,
                `object` = null,
                queue = NSOperationQueue.mainQueue,
            ) { _ -> it.releaseEmbedder() }
        }
    }

    /**
     * The app's people features, created on first use on the main thread, next to the core (the same
     * HTTP client; the records in `people/people.db`, see [get]) and bound to its state. [services]
     * makes the platform's services; it is called by the first call only, which every later call
     * returns the controller of without making a second set.
     */
    fun people(services: () -> PeopleServices, allowLocalHttp: Boolean): PeopleController = peopleInstance ?: run {
        val core = get(allowLocalHttp)
        PeopleController.create(PeopleDatabase.openLazily(peoplePath), http, services(), scope, allowLocalHttp).also {
            it.bind(core.state)
            peopleInstance = it
        }
    }
}
