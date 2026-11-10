package app.conferencecaddie.shared.bundle

import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.net.Http
import kotlinx.coroutines.CancellationException
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

    /** When `conferences.json` at [bundleBase] was last fetched or confirmed, or null. */
    suspend fun indexFetchedAt(bundleBase: String): Long? = database.cachedResponse("${bundleBase}conferences.json")?.fetchedAtMs

    /** The bundle installed for [scope], read from disk, or null. */
    suspend fun installed(backend: String, scope: String): TalkBundle? {
        val hash = database.installedBundle(scope) ?: return null
        val bytes = files.read(backend, hash) ?: return null
        return TalkBundle.decode(hash, bytes.getValue(BundleVerifier.BUNDLE_FILE), bytes[BundleVerifier.VECTOR_FILE])
    }

    /**
     * Makes the bundle of [entry] the installed bundle of [scope], downloading it from [bundleBase]
     * unless it is installed already.
     */
    suspend fun install(backend: String, scope: String, bundleBase: String, slug: String, entry: BundleEntry): InstallResult {
        val current = installed(backend, scope)
        if (current != null && current.contentHash == entry.contentHash) return InstallResult.Installed(current, updated = false)

        val downloaded = HashMap<String, ByteArray>()
        for (name in BundleVerifier.BUNDLE_FILES) {
            val expected = entry.files[name]?.bytes ?: return InstallResult.Failed(listOf("$name: not listed"), current)
            if (expected > MAX_FILE_BYTES) return InstallResult.Failed(listOf("$name: larger than the app accepts"), current)
            val response = try {
                http.get("$bundleBase${entry.path}$name", ifNoneMatch = null, maxBytes = expected)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                return InstallResult.Failed(listOf("$name: download failed"), current)
            }
            if (response.status != 200) return InstallResult.Failed(listOf("$name: status ${response.status}"), current)
            downloaded[name] = response.body
        }
        val problems = BundleVerifier.verify(entry.raw, downloaded)
        if (problems.isNotEmpty()) return InstallResult.Failed(problems, current)
        val bundle = TalkBundle.decode(
            entry.contentHash,
            downloaded.getValue(BundleVerifier.BUNDLE_FILE),
            downloaded.getValue(BundleVerifier.VECTOR_FILE),
        )
            ?: return InstallResult.Failed(listOf("${BundleVerifier.BUNDLE_FILE}: does not match the schema"), current)
        if (bundle.conference.slug != slug) {
            return InstallResult.Failed(listOf("${BundleVerifier.BUNDLE_FILE}: belongs to another conference"), current)
        }
        try {
            files.write(backend, entry.contentHash, downloaded)
            database.install(scope, bundle, nowMs())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return InstallResult.Failed(listOf("the bundle could not be stored"), current)
        }
        val keep = database.installedBundles().filterKeys { it.startsWith(scopePrefix(backend)) }.values.toSet()
        files.prune(backend, keep)
        return InstallResult.Installed(bundle, updated = true)
    }

    private fun parse(body: ByteArray): ConferenceIndex? = try {
        ConferenceIndex.read(json.parseToJsonElement(body.decodeToString()))
    } catch (_: Exception) {
        null
    }

    companion object {
        /** conferences.json lists every conference; a few hundred KB at most. */
        const val MAX_INDEX_BYTES = 8L * 1024 * 1024

        /** No bundle file is expected to come near this; KubeCon's bundle.json is about 1.3 MB. */
        const val MAX_FILE_BYTES = 64L * 1024 * 1024

        private val json = Json

        /** The scope of one conference of one backend: everything stored for it is keyed by this. */
        fun scope(backend: String, slug: String): String = "$backend\n$slug"

        fun scopePrefix(backend: String): String = "$backend\n"
    }
}
