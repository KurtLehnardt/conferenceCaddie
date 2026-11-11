package app.conferencecaddie.shared.bundle

import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.net.Http
import app.conferencecaddie.shared.net.ResponseTooLarge
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json

/**
 * Downloads and installs talk bundles (docs/contracts/talk-bundle.md, "Download, verification and
 * caching"):
 *
 * 1. `conferences.json` is fetched with `If-None-Match` when an ETag is known, and the last good
 *    copy is kept per URL, so the conference list works offline.
 * 2. For the selected conference, an installed bundle with the entry's content hash is used as it
 *    is. Otherwise exactly `bundle.json` and `vectors.i8` are downloaded from the entry's path, each
 *    read no further than the size the entry gives.
 * 3. The files are verified ([BundleVerifier]) and decoded ([TalkBundle.decode]); a bundle that
 *    fails is discarded and the previous one stays in use.
 * 4. A good bundle is written to its content-hash directory, then installed in the database in one
 *    transaction, and only then is the previous bundle's directory deleted.
 */
class BundleSync(
    private val http: Http,
    private val database: CaddieDatabase,
    private val files: BundleFiles,
    private val nowMs: () -> Long,
) {
    /** The conference list and where it came from. */
    data class IndexResult(
        val index: ConferenceIndex?,
        /** False when the list is the cached copy because the network or the host failed. */
        val fresh: Boolean,
        /** Why the network copy could not be used, when it could not. */
        val error: String?,
    )

    sealed interface InstallResult {
        data class Installed(val bundle: TalkBundle, val updated: Boolean) : InstallResult

        /** The new bundle could not be used; [kept] is the previous bundle, if there is one. */
        data class Failed(val problems: List<String>, val kept: TalkBundle?) : InstallResult
    }

    /** Reads `{bundleBase}conferences.json`, from the network when [refresh] is true or nothing is cached. */
    suspend fun index(bundleBase: String, refresh: Boolean): IndexResult {
        val url = "${bundleBase}conferences.json"
        val cached = database.cachedResponse(url)
        if (!refresh && cached != null) return IndexResult(parse(cached.body), fresh = false, error = null)
        val response = try {
            http.get(url, ifNoneMatch = cached?.etag, maxBytes = MAX_INDEX_BYTES)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return IndexResult(cached?.let { parse(it.body) }, fresh = false, error = "offline")
        }
        if (response.status == 304 && cached != null) {
            database.touchResponse(url, nowMs())
            return IndexResult(parse(cached.body), fresh = true, error = null)
        }
        if (response.status == 200) {
            val index = parse(response.body)
            if (index != null && index.ok) {
                database.storeResponse(url, response.body, response.etag, nowMs())
                return IndexResult(index, fresh = true, error = null)
            }
            val reason = index?.reason ?: "invalid"
            return IndexResult(cached?.let { parse(it.body) } ?: index, fresh = false, error = reason)
        }
        return IndexResult(cached?.let { parse(it.body) }, fresh = false, error = "status ${response.status}")
    }

    /** The stored copy of `conferences.json` at [bundleBase], without asking the network, or null. */
    suspend fun cachedIndex(bundleBase: String): ConferenceIndex? =
        database.cachedResponse("${bundleBase}conferences.json")?.let { parse(it.body) }?.takeIf { it.ok }

    /** When `conferences.json` at [bundleBase] was last fetched or confirmed, or null. */
    suspend fun indexFetchedAt(bundleBase: String): Long? = database.cachedFetchedAt("${bundleBase}conferences.json")

    /** The bundle installed for [scope], read from disk, or null when there is none or its files are gone. */
    suspend fun installed(backend: String, scope: String): TalkBundle? {
        val hash = database.installedBundle(scope) ?: return null
        val bytes = files.read(backend, hash) ?: return null
        return TalkBundle.decode(hash, bytes.getValue(BundleVerifier.BUNDLE_FILE), bytes[BundleVerifier.VECTOR_FILE])
    }

    /**
     * Makes the bundle of [entry] the installed bundle of [scope], downloading it from [bundleBase]
     * unless it is installed already. [current] is the installed bundle when the caller has it read
     * already, which saves reading it again.
     *
     * The downloads hold no lock. Writing the files, installing them in the database and deleting
     * the bundles no scope uses any more happen under one lock, so two installs never delete each
     * other's files.
     */
    suspend fun install(
        backend: String,
        scope: String,
        bundleBase: String,
        slug: String,
        entry: BundleEntry,
        current: TalkBundle? = null,
    ): InstallResult {
        val installedHash = database.installedBundle(scope)
        val have = current?.takeIf { it.contentHash == installedHash }
        if (installedHash == entry.contentHash) {
            // The database says it is installed; it is usable only while its files are there (an iOS
            // restore brings the database back without them).
            (have ?: installed(backend, scope))?.let { return InstallResult.Installed(it, updated = false) }
        }
        // The previous bundle, read only when a failure needs it.
        suspend fun kept(): TalkBundle? = have ?: if (installedHash != null) installed(backend, scope) else null

        // Everything the index promises is checked before a byte is downloaded, so a hostile index
        // cannot make the app hold more than the caps below.
        sizeProblem(entry)?.let { return InstallResult.Failed(listOf(it), kept()) }
        val checked = try {
            downloadAndVerify(bundleBase, slug, entry)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            // An allocation the device cannot make (OutOfMemoryError on Android) or any other
            // failure while checking: the bundle is refused, the app keeps running.
            Problems(listOf("${BundleVerifier.BUNDLE_FILE}: could not be checked on this device"))
        }
        if (checked is Problems) return InstallResult.Failed(checked.problems, kept())
        val (decoded, downloaded) = checked as Verified
        val stored = commit.withLock {
            try {
                files.write(backend, entry.contentHash, downloaded)
                database.install(scope, decoded, nowMs())
                val keep = database.installedBundles().filterKeys { it.startsWith(scopePrefix(backend)) }.values.toSet()
                files.prune(backend, keep)
                true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                false
            }
        }
        if (!stored) return InstallResult.Failed(listOf("the bundle could not be stored"), kept())
        return InstallResult.Installed(decoded, updated = true)
    }

    private sealed interface Checked

    private class Problems(val problems: List<String>) : Checked

    private data class Verified(val bundle: TalkBundle, val files: Map<String, ByteArray>) : Checked

    // Downloads the entry's files one after the other, each no longer than the index says, then
    // verifies and decodes them.
    private suspend fun downloadAndVerify(bundleBase: String, slug: String, entry: BundleEntry): Checked {
        val downloaded = HashMap<String, ByteArray>()
        for (name in BundleVerifier.BUNDLE_FILES) {
            val expected = entry.files.getValue(name).bytes
            val response = try {
                http.get("$bundleBase${entry.path}$name", ifNoneMatch = null, maxBytes = expected)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ResponseTooLarge) {
                return Problems(listOf("$name: larger than the index says"))
            } catch (e: Exception) {
                return Problems(listOf("$name: $DOWNLOAD_FAILED"))
            }
            if (response.status != 200) return Problems(listOf("$name: status ${response.status}"))
            downloaded[name] = response.body
        }
        val problems = BundleVerifier.verify(entry.raw, downloaded)
        if (problems.isNotEmpty()) return Problems(problems)
        val bundle = TalkBundle.decode(
            entry.contentHash,
            downloaded.getValue(BundleVerifier.BUNDLE_FILE),
            downloaded.getValue(BundleVerifier.VECTOR_FILE),
        )
            ?: return Problems(listOf("${BundleVerifier.BUNDLE_FILE}: does not match the schema"))
        if (bundle.conference.slug != slug) return Problems(listOf("${BundleVerifier.BUNDLE_FILE}: belongs to another conference"))
        return Verified(bundle, downloaded)
    }

    private fun parse(body: ByteArray): ConferenceIndex? = try {
        ConferenceIndex.read(json.parseToJsonElement(body.decodeToString()))
    } catch (_: Exception) {
        null
    }

    private val commit = Mutex()

    companion object {
        /** The problem an install reports when a file could not be downloaded. */
        const val DOWNLOAD_FAILED = "download failed"

        /**
         * conferences.json lists every conference in about 1.3 KB each, so this holds some 750; it
         * also keeps the list's request timeout at about two minutes (KtorHttp.requestTimeoutFor).
         */
        const val MAX_INDEX_BYTES = 1L * 1024 * 1024

        /**
         * The largest bundle.json the app reads. KubeCon North America's, with 484 talks, is about
         * 1.3 MB; the cap leaves room for ten times that. Reading one means its bytes, its text
         * and its JSON tree at once, so the cap is what keeps a hostile index from exhausting memory.
         */
        const val MAX_BUNDLE_JSON_BYTES = 16L * 1024 * 1024

        /** The largest vectors.i8: 384 bytes a row, so some 87,000 rows. KubeCon's is 215 KB. */
        const val MAX_VECTOR_BYTES = 32L * 1024 * 1024

        /** The cap of each bundle file, by name. */
        fun maxBytes(name: String): Long? = when (name) {
            BundleVerifier.BUNDLE_FILE -> MAX_BUNDLE_JSON_BYTES
            BundleVerifier.VECTOR_FILE -> MAX_VECTOR_BYTES
            else -> null
        }

        /**
         * Why the sizes [entry] lists cannot be downloaded, or null: a file missing from the list,
         * one larger than its cap, or a vector file whose size is not the entry's vector count times
         * its dimensions (which the verifier would refuse after the download anyway).
         */
        fun sizeProblem(entry: BundleEntry): String? {
            for (name in BundleVerifier.BUNDLE_FILES) {
                val bytes = entry.files[name]?.bytes ?: return "$name: not listed"
                val cap = maxBytes(name) ?: return "$name: not a bundle file"
                if (bytes > cap) return "$name: larger than the app accepts"
            }
            val count = entry.vectorCount?.toLong() ?: return "${BundleVerifier.VECTOR_FILE}: no vector count"
            val dims = entry.dims?.toLong() ?: return "${BundleVerifier.VECTOR_FILE}: no dimensions"
            if (entry.files.getValue(BundleVerifier.VECTOR_FILE).bytes != count * dims) {
                return "${BundleVerifier.VECTOR_FILE}: size is not the vector count times the dimensions"
            }
            return null
        }

        private val json = Json

        /** The scope of one conference of one backend: everything stored for it is keyed by this. */
        fun scope(backend: String, slug: String): String = "$backend\n$slug"

        fun scopePrefix(backend: String): String = "$backend\n"
    }
}
