package app.conferencecaddie.shared.importer

import app.conferencecaddie.shared.bundle.Talk

/** The largest schedule file the import reads, as on the web and the servers: 5 MB. */
const val MAX_IMPORT_BYTES = 5 * 1024 * 1024

/** The longest pasted text the import reads, as on the web and the servers: 200,000 characters. */
const val MAX_IMPORT_TEXT = 200_000

/** What the person gave the import: a file's bytes with its name and type, or pasted text. */
sealed interface ImportInput {
    /**
     * A file picked on the device. [filename] and [mime] only help choose the format (a `.csv` or
     * `.tsv` name, or a CSV type, reads as CSV); the content decides everything else.
     */
    class File(val bytes: ByteArray, val filename: String, val mime: String) : ImportInput

    /** Text the person pasted. */
    data class Text(val text: String) : ImportInput
}

/**
 * How sure a match is, from the named queries that matched (docs/CONTRACT.md, "Import my
 * schedule"): the title as a phrase, then the title's words with the speakers, then with the start
 * time, then the title's words alone. Only [TitleWords] is weak: the review leaves it unticked.
 */
enum class ImportConfidence(val wire: String) {
    ExactTitle("exact_title"),
    TitleAndSpeaker("title_and_speaker"),
    TitleAndTime("title_and_time"),
    TitleWords("title_words"),
    ;

    val strong: Boolean get() = this != TitleWords

    companion object {
        /** The value of a response's `confidence`, or null when it is not one of the four. */
        fun fromWire(value: String?): ImportConfidence? = entries.firstOrNull { it.wire == value }
    }
}

/** A talk found in the schedule, with the line of the file that found it (at most 160 characters). */
data class ImportMatch(val talk: Talk, val confidence: ImportConfidence, val excerpt: String)

/**
 * The import's answer, as `POST /api/import/schedule` gives it: the talks found, in the order they
 * appear in the file; how many items of the file offered a title but matched no talk; and the
 * number of characters read.
 */
data class ImportResult(val matched: List<ImportMatch>, val unmatchedCount: Int, val extractedChars: Int)

/** Why an import did not run. The screens word each one; [ImportOutcome.Refused] may carry the server's words. */
enum class ImportRefusal {
    /** The file is larger than [MAX_IMPORT_BYTES]. */
    TooLarge,

    /** The file has no bytes. */
    Empty,

    /** The file is not UTF-8 text. */
    Unsupported,

    /** A PDF, Word, OpenDocument or RTF file, which native v1 does not read (docs/NATIVE_PLAN.md, decision 8). */
    Document,

    /** The file holds nothing but white space. */
    Unreadable,

    /** The pasted text is empty. */
    PasteEmpty,

    /** The pasted text is longer than [MAX_IMPORT_TEXT] characters. */
    PasteTooLong,

    /** The server refused the schedule; [ImportOutcome.Refused.serverMessage] holds its words. */
    Server,

    /** No conference's schedule is ready on this device. */
    Unavailable,
}

sealed interface ImportOutcome {
    /** The import ran; [onServer] is true when the backend's import answered rather than the device's. */
    data class Done(val result: ImportResult, val onServer: Boolean) : ImportOutcome

    /** The import did not run. [serverMessage] is the server's sentence for [ImportRefusal.Server]. */
    data class Refused(val reason: ImportRefusal, val serverMessage: String? = null) : ImportOutcome
}
