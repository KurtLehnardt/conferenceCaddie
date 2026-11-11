package app.conferencecaddie.shared.importer

import app.conferencecaddie.shared.bundle.TalkBundle

/**
 * "Import my schedule" on the device: the checks of the Worker's `validate()` and `decodeText()`
 * (worker/src/talks/import.js), then [ScheduleParser] and [ScheduleMatcher] over the selected
 * conference's bundle. Nothing is stored and nothing leaves the device.
 *
 * Native v1 reads no PDF, Word, OpenDocument or RTF file (docs/NATIVE_PLAN.md, decision 8): a file
 * that is one by its name, its type or its first bytes is refused as [ImportRefusal.Document].
 */
object ScheduleImport {
    /** The text of an input that passed the checks, with the hints that help choose its format. */
    class Prepared internal constructor(
        val text: String,
        val filename: String,
        val mime: String,
        /** True for a file, false for pasted text. */
        val isFile: Boolean,
    )

    sealed interface Checked {
        class Ok(val prepared: Prepared) : Checked

        class Refused(val reason: ImportRefusal) : Checked
    }

    private val DOC_EXTENSIONS = setOf("pdf", "doc", "docx", "odt", "rtf")
    private val DOC_MIMES = listOf(
        "application/pdf", "application/msword", "application/rtf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.oasis.opendocument.text",
        "text/rtf",
    )
    private val OLE_MAGIC = byteArrayOf(0xD0.toByte(), 0xCF.toByte(), 0x11, 0xE0.toByte(), 0xA1.toByte(), 0xB1.toByte(), 0x1A, 0xE1.toByte())
    private val ZIP_MAGIC = byteArrayOf(0x50, 0x4B, 0x03, 0x04)

    /**
     * A document only an extractor can turn into text (the Worker's `isDocument`): by its name
     * (`.pdf`, `.doc`, `.docx`, `.odt`, `.rtf`), its type, `%PDF-` in its first kilobyte, a zip or
     * legacy Office header, or `{\rtf` at the start.
     */
    fun isDocument(bytes: ByteArray, filename: String, mime: String): Boolean {
        val dot = filename.lastIndexOf('.')
        if (dot >= 0 && filename.substring(dot + 1).lowercase() in DOC_EXTENSIONS) return true
        for (m in DOC_MIMES) {
            if (JsText.startsWithAsciiIgnoreCase(mime, m) && (mime.length == m.length || !JsText.isAsciiWord(mime[m.length]))) return true
        }
        val head = bytes.copyOf(minOf(bytes.size, 1024))
        if (indexOf(head, "%PDF-".encodeToByteArray()) >= 0) return true
        if (startsWith(bytes, ZIP_MAGIC) || startsWith(bytes, OLE_MAGIC)) return true
        return startsWith(bytes, "{\\rtf".encodeToByteArray())
    }

    private fun startsWith(bytes: ByteArray, sig: ByteArray) = bytes.size >= sig.size && sig.indices.all { bytes[it] == sig[it] }

    private fun indexOf(bytes: ByteArray, sig: ByteArray): Int {
        outer@ for (i in 0..bytes.size - sig.size) {
            for (j in sig.indices) if (bytes[i + j] != sig[j]) continue@outer
            return i
        }
        return -1
    }

    /**
     * Checks [input] as the Worker does, in the same order: a file over 5 MB, an empty file, a
     * document and a file that is not UTF-8 are refused; pasted text that is empty or longer than
     * 200,000 characters is refused; then a byte order mark is removed (two for a file, as
     * TextDecoder removes one before the import removes another) and text with nothing but white
     * space left is unreadable.
     */
    fun check(input: ImportInput): Checked {
        val prepared = when (input) {
            is ImportInput.File -> {
                val bytes = input.bytes
                if (bytes.size > MAX_IMPORT_BYTES) return Checked.Refused(ImportRefusal.TooLarge)
                if (bytes.isEmpty()) return Checked.Refused(ImportRefusal.Empty)
                if (isDocument(bytes, input.filename, input.mime)) return Checked.Refused(ImportRefusal.Document)
                val text = try {
                    bytes.decodeToString(0, bytes.size, throwOnInvalidSequence = true)
                } catch (_: Exception) {
                    return Checked.Refused(ImportRefusal.Unsupported)
                }
                Prepared(text.removePrefix("﻿").removePrefix("﻿"), input.filename, input.mime, isFile = true)
            }
            is ImportInput.Text -> {
                if (input.text.length > MAX_IMPORT_TEXT) return Checked.Refused(ImportRefusal.PasteTooLong)
                if (JsText.trim(input.text).isEmpty()) return Checked.Refused(ImportRefusal.PasteEmpty)
                Prepared(input.text.removePrefix("﻿"), "", "", isFile = false)
            }
        }
        if (JsText.trim(prepared.text).isEmpty()) return Checked.Refused(ImportRefusal.Unreadable)
        return Checked.Ok(prepared)
    }

    /** The import of [prepared] over [bundle]'s talks, on this device. CPU work: run it off the main thread. */
    fun onDevice(prepared: Prepared, bundle: TalkBundle): ImportResult {
        val c = bundle.conference
        return run(prepared, ImportConference(c.slug, c.startDate, c.timeZone), ScheduleMatcher(bundle.talks))
    }

    internal fun run(prepared: Prepared, conference: ImportConference, matcher: ScheduleMatcher): ImportResult {
        val candidates = candidatesOf(prepared, conference)
        return matcher.run(candidates, prepared.text.length)
    }

    /** The candidates the import tries for [prepared]: parsing alone, for the tests. */
    internal fun candidatesOf(prepared: Prepared, conference: ImportConference): List<ImportCandidate> {
        val detected = ScheduleParser.detect(prepared.text, prepared.filename, prepared.mime)
        val entries = ScheduleParser.entries(prepared.text, detected, prepared.filename, conference)
        return ScheduleParser.candidates(entries.take(MAX_ENTRIES))
    }
}
