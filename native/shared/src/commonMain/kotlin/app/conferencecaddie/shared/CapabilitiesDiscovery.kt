package app.conferencecaddie.shared

import app.conferencecaddie.shared.net.Http
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Finds out what a backend can do (docs/contracts/capabilities.md, "Discovery and the legacy
 * backend"; reference `discoverCapabilities()` in contracts/js/capabilities.mjs):
 *
 * 1. `GET {base}/api/capabilities` (tiers 2 and 3).
 * 2. Otherwise `GET {base}/capabilities.json` (tier 1).
 * 3. Only when step 1 answered 404 with exactly `{ "error": "Not found" }` and the backend has never
 *    served a document to this device: `GET {base}/api/health`, which must answer 200 with exactly
 *    `{ "ok": true }`. Both together mean the legacy server.
 *
 * A failure is never read as legacy. The caller keeps the last good result per backend base and
 * passes `hadDocument`, so a backend that once served a document is never downgraded.
 */
object CapabilitiesDiscovery {
    /** Capabilities documents are small; anything larger is not one. */
    const val MAX_DOCUMENT_BYTES = 64L * 1024

    sealed interface Result {
        /** A usable answer. [document] is null for the legacy server, which has none. */
        data class Found(
            val source: Source,
            val version: Int,
            val document: JsonObject?,
            val capabilities: Capabilities,
            val maxAgeSeconds: Long?,
        ) : Result

        /** The backend serves only documents a newer app can read. */
        data object UpdateApp : Result

        /** Unreachable, or not a Caddie backend. */
        data object Unreachable : Result
    }

    enum class Source { Api, Static, Legacy }

    suspend fun discover(
        base: String,
        http: Http,
        hadDocument: Boolean,
        allowLocalHttpBundleBase: Boolean = false,
    ): Result {
        var legacyNotFound = false
        var tooNew = false
        for ((source, path) in listOf(Source.Api to "/api/capabilities", Source.Static to "/capabilities.json")) {
            val response = try {
                http.get("$base$path", ifNoneMatch = null, maxBytes = MAX_DOCUMENT_BYTES)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                continue
            }
            val body = Capabilities.parseJson(response.text())
            if (source == Source.Api) legacyNotFound = response.status == 404 && exactly(body, "error", "\"Not found\"")
            val doc = body.asObject()
            if (response.status != 200 || doc == null) continue
            when (val n = Capabilities.negotiate(doc)) {
                is Capabilities.Negotiation.Ok -> return Result.Found(
                    source = source,
                    version = n.version,
                    document = doc,
                    capabilities = Capabilities.effective(doc, allowLocalHttpBundleBase),
                    maxAgeSeconds = response.maxAgeSeconds(),
                )
                Capabilities.Negotiation.UpdateApp -> tooNew = true
                Capabilities.Negotiation.Invalid -> Unit
            }
        }
        if (tooNew) return Result.UpdateApp
        if (legacyNotFound && !hadDocument) {
            try {
                val h = http.get("$base/api/health", ifNoneMatch = null, maxBytes = MAX_DOCUMENT_BYTES)
                if (h.status == 200 && exactly(Capabilities.parseJson(h.text()), "ok", "true")) {
                    return Result.Found(Source.Legacy, 1, null, Capabilities.Legacy, maxAgeSeconds = null)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Fall through: a failure is never read as legacy.
            }
        }
        return Result.Unreachable
    }

    // True when body is an object with exactly one key, [key], whose value is the JSON literal
    // [literal] (a string is compared with its quotes).
    private fun exactly(body: JsonElement?, key: String, literal: String): Boolean {
        val o = body.asObject() ?: return false
        return o.size == 1 && o[key]?.toString() == literal
    }
}
