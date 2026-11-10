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
     * The app's core, created on first use, on the main thread. The database and the bundles live in
     * Application Support. The bundles can be downloaded again, so their directory is excluded from
     * iCloud and device backups; the database holds the interested lists and stays in backups.
     */
    @OptIn(ExperimentalForeignApi::class)
    fun get(allowLocalHttp: Boolean): CaddieCore = instance ?: run {
        val fm = NSFileManager.defaultManager
        val support = fm.URLForDirectory(NSApplicationSupportDirectory, NSUserDomainMask, null, true, null)
            ?: error("Application Support is not available")
        val dir = support.URLByAppendingPathComponent("caddie", isDirectory = true)!!
        val bundles = dir.URLByAppendingPathComponent("bundles", isDirectory = true)!!
        fm.createDirectoryAtURL(bundles, withIntermediateDirectories = true, attributes = null, error = null)
        bundles.setResourceValue(NSNumber(bool = true), forKey = NSURLIsExcludedFromBackupKey, error = null)
        val dbPath = dir.URLByAppendingPathComponent("caddie.db")!!.path!!
        CaddieCore(
            database = CaddieDatabase.open(dbPath),
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
