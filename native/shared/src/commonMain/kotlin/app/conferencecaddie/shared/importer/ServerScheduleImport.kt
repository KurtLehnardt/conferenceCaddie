package app.conferencecaddie.shared.importer

import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.net.PostJson
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The backend's import, for a backend whose capabilities say `imports.schedule: server`:
 * `POST {base}/api/import/schedule` with `{ event, text, filename?, mime? }` (docs/CONTRACT.md,
 * DECISIONS.md "Tier 3 schedule import accepts text with format hints"). A file's UTF-8 text is sent
 * with its name and type as format hints; pasted text is sent alone. The request carries no cookie,
 * credential or `Origin`, and nothing of it is logged.
 *
 * The answer's talks are the bundle's talks with the same ids; a talk the bundle on this device does
 * not hold is left out and counted with the entries that matched nothing, so the review only ever
 * offers talks the device can show.
 */
internal class ServerScheduleImport(private val post: PostJson) {
    sealed interface Answer {
        class Done(val result: ImportResult) : Answer

        class Refused(val outcome: ImportOutcome.Refused) : Answer

        /** No usable answer (no network, a timeout, a server error or limit, an unexpected body): import on the device instead. */
        data object Fallback : Answer
    }

    /**
     * Sends [prepared] for the conference [slug] to the backend at [base] (a normalised base without
     * a trailing slash). [hints] is false for a legacy backend, whose route refused `filename` and
     * `mime` next to `text`.
     */
    suspend fun run(base: String, slug: String, prepared: ScheduleImport.Prepared, hints: Boolean, bundle: TalkBundle): Answer {
        val body = buildJsonObject {
            put("event", slug)
            put("text", prepared.text)
            if (prepared.isFile && hints) {
                if (prepared.filename.isNotEmpty()) put("filename", prepared.filename.take(MAX_FILENAME))
                if (prepared.mime.isNotEmpty()) put("mime", prepared.mime.take(MAX_MIME))
            }
        }.toString().encodeToByteArray()
        val response = try {
            post.post("$base/api/import/schedule", body, TIMEOUT_MS, MAX_RESPONSE_BYTES)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            return Answer.Fallback
        }
        return when (response.status) {
            200 -> parse(response.text(), prepared, bundle)?.let { Answer.Done(it) } ?: Answer.Fallback
            413 -> Answer.Refused(refusal(response.text(), if (prepared.isFile) ImportRefusal.TooLarge else ImportRefusal.PasteTooLong))
            422 -> Answer.Refused(refusal(response.text(), if (prepared.isFile) ImportRefusal.Unreadable else ImportRefusal.PasteEmpty))
            else -> Answer.Fallback
        }
    }

    // The server's own sentence when it sent a short plain one, else the device's refusal.
    private fun refusal(text: String, local: ImportRefusal): ImportOutcome.Refused {
        val message = try {
            ((BoundedJson().parse(text) as? JsonObject)?.get("error") as? JsonPrimitive)?.takeIf { it.isString }?.content
        } catch (_: Exception) {
            null
        }
        val usable = message?.trim()?.takeIf { m -> m.length in 1..MAX_MESSAGE && m.none { it.isISOControl() } }
        return if (usable != null) ImportOutcome.Refused(ImportRefusal.Server, usable) else ImportOutcome.Refused(local)
    }

    private fun parse(text: String, prepared: ScheduleImport.Prepared, bundle: TalkBundle): ImportResult? {
        val o = try {
            BoundedJson().parse(text) as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return null
        val matched = o["matched"] as? JsonArray ?: return null
        val seen = HashSet<String>()
        var dropped = 0
        val out = ArrayList<ImportMatch>()
        for (e in matched) {
            val m = e as? JsonObject ?: return null
            val id = ((m["talk"] as? JsonObject)?.get("talk_id") as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
            if (!seen.add(id)) continue
            val talk = bundle.talksById[id]
            if (talk == null) {
                dropped++
                continue
            }
            val confidence = ImportConfidence.fromWire((m["confidence"] as? JsonPrimitive)?.takeIf { it.isString }?.content) ?: ImportConfidence.TitleWords
            val excerpt = (m["matched_text_excerpt"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { ScheduleMatcher.excerpt(it) } ?: ""
            out += ImportMatch(talk, confidence, excerpt)
        }
        val unmatched = (o["unmatched_count"] as? JsonPrimitive)?.content?.toIntOrNull()?.coerceAtLeast(0) ?: 0
        val chars = (o["extracted_chars"] as? JsonPrimitive)?.content?.toIntOrNull()?.coerceAtLeast(0) ?: prepared.text.length
        return ImportResult(out, unmatched + dropped, chars)
    }

    companion object {
        /** The server reads the file and runs one search per candidate; a minute covers a slow venue network. */
        const val TIMEOUT_MS = 60_000L
        const val MAX_RESPONSE_BYTES = 4L * 1024 * 1024
        private const val MAX_FILENAME = 255
        private const val MAX_MIME = 127
        private const val MAX_MESSAGE = 300
    }
}
