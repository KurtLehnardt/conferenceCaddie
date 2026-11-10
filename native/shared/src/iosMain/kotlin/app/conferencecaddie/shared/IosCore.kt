package app.conferencecaddie.shared.core

import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.net.KtorHttp
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.io.files.Path
import platform.Foundation.NSApplicationSupportDirectory
import platform.Foundation.NSFileManager
import platform.Foundation.NSNumber
import platform.Foundation.NSURLIsExcludedFromBackupKey
import platform.Foundation.NSUserDomainMask

/** The one [CaddieCore] of the app. */
object IosCore {
    private var instance: CaddieCore? = null

    /**
     * The app's core, created on first use, on the main thread. Everything lives in Application
     * Support under `caddie/`:
     *
     * - `caddie.db`, the main database: settings and the marked talks, which stay in iCloud and
     *   device backups.
     * - `cache/cache.db`, the cache database (the conference lists, the installed bundles and the
     *   search index), and `bundles/`, the bundle files. Both can be downloaded again, so their
     *   directories are excluded from backups; after a restore the app downloads them again.
     *
     * The databases open on their own I/O thread at the first statement, and one that cannot be
     * opened is replaced rather than crashing every start ([CaddieDatabase.openLazily]).
     */
    @OptIn(ExperimentalForeignApi::class)
    fun get(allowLocalHttp: Boolean): CaddieCore = instance ?: run {
        val fm = NSFileManager.defaultManager
        val support = fm.URLForDirectory(NSApplicationSupportDirectory, NSUserDomainMask, null, true, null)
            ?: error("Application Support is not available")
        val dir = support.URLByAppendingPathComponent("caddie", isDirectory = true)!!
        val bundles = dir.URLByAppendingPathComponent("bundles", isDirectory = true)!!
        val cache = dir.URLByAppendingPathComponent("cache", isDirectory = true)!!
        for (excluded in listOf(bundles, cache)) {
            fm.createDirectoryAtURL(excluded, withIntermediateDirectories = true, attributes = null, error = null)
            excluded.setResourceValue(NSNumber(bool = true), forKey = NSURLIsExcludedFromBackupKey, error = null)
        }
        val dbPath = dir.URLByAppendingPathComponent("caddie.db")!!.path!!
        val cachePath = cache.URLByAppendingPathComponent("cache.db")!!.path!!
        CaddieCore(
            database = CaddieDatabase.openLazily(dbPath, cachePath),
            files = BundleFiles(Path(bundles.path!!)),
            http = KtorHttp(),
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
            allowLocalHttp = allowLocalHttp,
        ).also {
            instance = it
            it.start()
        }
    }
}
