package app.conferencecaddie.shared.importer

import kotlin.time.Clock
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The conference a schedule is read for: its slug, its first day (for years a file leaves out) and its time zone. */
internal data class ImportConference(val slug: String, val startDate: String?, val timeZone: String?)

/**
 * One item of a schedule: the texts it offers as a title, in order of preference, the speaker text
 * near it, an optional start instant, and whether it is clearly one schedule entry (a structured
 * title, or a line that starts with a time), whose title may then have only two words.
 */
internal data class ImportEntry(val variants: List<String>, val context: String, val hintMs: Long?, val short: Boolean = false)

/**
 * A title-like text sent to the matcher: [entries] are the indexes of the items that offered it,
 * [exact] says whether it may match as an exact title (three content words or more), [context] is
 * the speaker text (at most 300 characters) and [hintMs] the start instant.
 */
internal class ImportCandidate(val text: String, val entries: MutableSet<Int>, val exact: Boolean, val context: String, val hintMs: Long?)

/**
 * Schedule files into entries and entries into candidates: worker/src/talks/import-parse.js, itself
 * the parsing of server/import.mjs, ported line by line. It reads iCalendar, CSV and TSV, JSON
 * (Sessionize and Sched exports and generic arrays) and plain text.
 *
 * Reading is bounded exactly as there: the text is read line by line by index, never split into one
 * array; each line, CSV cell and iCalendar property is cut to 1,000 characters before anything
 * looks at it; plain text and iCalendar stop after 100,000 lines, CSV after 5,000 rows or 100,000
 * cells, and every parser once it holds 3,000 entries; speaker text stops growing at 300
 * characters; a JSON speaker field gives at most 100 names; and there are at most 300 candidates,
 * each cut to 300 characters before its trailing punctuation is stripped. The JavaScript patterns
 * that could backtrack on long input are written out by hand ([JsText], [ImportTime]); the regular
 * expressions left run only on lines already cut to 1,000 characters and squashed to single spaces,
 * and use explicit ASCII classes, so they mean the same on every platform.
 */
internal object ScheduleParser {
    enum class Format { Ics, Json, Csv, Text }

    class Detected(val format: Format, val json: JsonElement? = null)

    private val TITLE_HEADERS = listOf(
        "title", "session title", "talk title", "session name", "session", "talk", "name", "event name", "event title",
        "summary", "subject", "event",
    )

    /** A header cell lowercased, with every run of other characters than a-z and 0-9 turned into one space. */
    fun normHeader(h: String): String {
        val lower = h.lowercase()
        val sb = StringBuilder(lower.length)
        var pending = false
        for (c in lower) {
            if (c in 'a'..'z' || c in '0'..'9') {
                if (pending && sb.isNotEmpty()) sb.append(' ')
                pending = false
                sb.append(c)
            } else {
                pending = true
            }
        }
        return sb.toString()
    }

    // ---------------------------------------------------------------------------------------------
    // The format.

    /** The format of [text] (`textFormat`), with the parsed value for JSON, so a file is parsed once. */
    fun detect(text: String, filename: String, mime: String): Detected {
        val t = JsText.trimStart(text)
        if (JsText.startsWithAsciiIgnoreCase(t, "BEGIN:VCALENDAR")) return Detected(Format.Ics)
        if (t.startsWith('{') || t.startsWith('[')) {
            // Read with a bound on memory: a hostile file cannot build a tree of millions of values.
            val value = BoundedJson().parse(t)
            if (value is JsonObject || value is JsonArray) return Detected(Format.Json, value)
        }
        val ext = JsText.extension(filename)
        if (ext == "csv" || ext == "tsv" || JsText.startsWithAsciiIgnoreCase(mime, "text/csv") ||
            JsText.startsWithAsciiIgnoreCase(mime, "text/tab-separated-values")
        ) {
            return Detected(Format.Csv)
        }
        // A first line with a delimiter and a title-like column name reads as a CSV header.
        val first = importFirstLine(t)
        val delim = csvDelimiter(first)
        if (delim != null && parseCsv(first, delim).firstOrNull()?.any { normHeader(it) in TITLE_HEADERS } == true) return Detected(Format.Csv)
        return Detected(Format.Text)
    }

    /** The entries of [text] in the [detected] format; [clock] only gives the text format a year when the conference has none. */
    fun entries(text: String, detected: Detected, filename: String, conference: ImportConference, clock: Clock = Clock.System): List<ImportEntry> = when (detected.format) {
        Format.Ics -> icsEntries(text, conference)
        Format.Json -> jsonEntries(detected.json!!, conference)
        Format.Csv -> csvEntries(text, conference, filename)
        Format.Text -> textEntries(text, conference, clock)
    }

    // ---------------------------------------------------------------------------------------------
    // Free text.

    private val NOISE_LINE = Regex(
        "(?:add (?:it )?to (?:my |your )?(?:calendar|schedule|sched|google calendar|outlook|ical)|" +
            "remove from (?:my |your )?(?:calendar|schedule|sched)|view (?:session )?details|more info(?:rmation)?|" +
            "join (?:the )?waitlist|this session is full|filling up|page [0-9]+(?: of [0-9]+)?|[0-9]+ *(?:/|of) *[0-9]+|[0-9]+)",
        RegexOption.IGNORE_CASE,
    )
    private val URL_LINE = Regex("(?:https?://|www\\.)[^ ]*", RegexOption.IGNORE_CASE)
    private val CONTEXT_LABEL = Regex("^(?:speakers?|presenters?|moderators?|panel(?:ists)?|hosts?|instructors?|by) *: *", RegexOption.IGNORE_CASE)
    private val DROP_LABEL = Regex(
        "^(?:rooms?|location|where|venue|track|type|session type|format|level|experience level|audience|tags?|" +
            "categor(?:y|ies)|when|time|date|language|capacity|status) *:",
        RegexOption.IGNORE_CASE,
    )
    private val ROOM_WORD = Regex(
        "(?<![A-Za-z0-9_])(?:room|rooms|hall|level|floor|building|bldg|salon|ballroom|suite|theater|theatre|stage|booth|" +
            "lobby|foyer|auditorium|pavilion|terrace|lounge|expo|exhibit|exhibition|mezzanine|wing|online|virtual)(?![A-Za-z0-9_])",
        RegexOption.IGNORE_CASE,
    )
    private val ROOM_NUMBER = Regex("(?<![A-Za-z0-9_])[A-Z]?[0-9]{2,4}[A-Z]?(?:-[0-9]{2,4}[A-Z]?)?(?![A-Za-z0-9_])")

    // One address and nothing else, with a dot in the domain, checked without a pattern.
    private fun emailLine(line: String): Boolean {
        if (line.length > 254) return false
        val at = line.indexOf('@')
        if (at <= 0 || at == line.length - 1 || line.indexOf('@', at + 1) >= 0 || line.any { JsText.isSpace(it) }) return false
        val dot = line.lastIndexOf('.')
        return dot > at + 1 && dot < line.length - 1
    }

    // "Salt Palace | Level 2 | Room 250 A" or "Room 250 A": short pieces, one of which names a room.
    private fun roomLike(line: String): Boolean {
        val segs = line.split('|', '•', '·', '/').map { it.trim(' ') }.filter { it.isNotEmpty() }
        if (segs.isEmpty() || segs.any { it.split(' ').size > 4 }) return false
        val roomish = segs.any { ROOM_WORD.containsMatchIn(it) || ROOM_NUMBER.containsMatchIn(it) }
        return roomish && (segs.size >= 2 || (ROOM_WORD.containsMatchIn(line) && line.any { JsText.isDigit(it) }))
    }

    /**
     * Removes a session-type badge after a stripped time: one letter or number, or a run of symbols
     * such as an emoji, followed by white space (`stripBadge`).
     */
    fun stripBadge(s: String): String {
        if (s.isEmpty()) return s
        fun spacesFrom(i: Int): Int {
            var j = i
            while (j < s.length && JsText.isSpace(s[j])) j++
            return j
        }
        if (JsText.isWordChar(s[0])) {
            val end = spacesFrom(1)
            return if (end > 1) s.substring(end) else s
        }
        var i = 0
        while (i < s.length && !JsText.isWordChar(s[i]) && !JsText.isSpace(s[i]) && s[i] !in BADGE_KEEP) i++
        if (i == 0) return s
        val end = spacesFrom(i)
        return if (end > i) s.substring(end) else s
    }

    private const val BADGE_KEEP = "\"'“‘(["

    class Split(val variants: List<String>, val after: String)

    /**
     * The title before a final " - " (or "–", "—", "|") speaker suffix, and the first part
     * (`splitVariants`). The text is squashed, so a separator is a run of white space, the dash or
     * bar, and another run.
     */
    fun splitVariants(text: String): Split {
        val parts = ArrayList<String>()
        var last = 0
        var i = 0
        while (i < text.length) {
            if (!JsText.isSpace(text[i])) {
                i++
                continue
            }
            var j = i
            while (j < text.length && JsText.isSpace(text[j])) j++
            if (j < text.length && text[j] in "-–—|" && j + 1 < text.length && JsText.isSpace(text[j + 1])) {
                var k = j + 1
                while (k < text.length && JsText.isSpace(text[k])) k++
                parts += text.substring(last, i)
                last = k
                i = k
            } else {
                i = j
            }
        }
        parts += text.substring(last)
        if (parts.size < 2) return Split(emptyList(), "")
        return Split(listOf(parts.dropLast(1).joinToString(" - "), parts[0]), parts.last())
    }

    private class Block(val minutes: Int?) {
        val lines = ArrayList<String>()
        val context = ArrayList<String>()
        var contextChars = 0
    }

    private fun currentYear(clock: Clock): Int = clock.now().toLocalDateTime(TimeZone.UTC).year

    /** The text format. A date without a year takes the conference's start year; without one, the year of [clock] in UTC. */
    fun textEntries(text: String, conference: ImportConference, clock: Clock = Clock.System): List<ImportEntry> {
        val defaultYear = conference.startDate?.take(4)?.toIntOrNull()?.takeIf { it != 0 } ?: currentYear(clock)
        val zone = conference.timeZone?.takeIf { it.isNotEmpty() } ?: "UTC"
        val entries = ArrayList<ImportEntry>()
        var date: Triple<Int, Int, Int>? = null
        var pendingMinutes: Int? = null
        var block: Block? = null

        fun flush() {
            val b = block ?: return
            block = null
            if (b.lines.isEmpty() || entries.size >= MAX_ENTRIES) return
            val d = date
            val hint = if (d != null && b.minutes != null) ImportTime.localToMs(d.first, d.second, d.third, b.minutes, zone) else null
            // More than four text lines is a list, one item per line, not one wrapped title.
            if (b.lines.size > 4) {
                for (line in b.lines) {
                    if (entries.size >= MAX_ENTRIES) return
                    val split = splitVariants(line)
                    entries += ImportEntry(listOf(line) + split.variants, (listOf(split.after) + b.context).joinToString(" "), null)
                }
                return
            }
            val merged = b.lines.joinToString(" ")
            val split = splitVariants(merged)
            val variants = ArrayList<String>()
            variants += split.variants.take(1)
            variants += merged
            variants += split.variants.drop(1)
            if (b.lines.size > 1) variants += b.lines
            // An item that starts with a time is clearly one schedule entry, so its title may be short.
            entries += ImportEntry(variants, (listOf(split.after) + b.context).joinToString(" "), hint, short = b.minutes != null)
        }

        fun start(minutes: Int?): Block {
            flush()
            return Block(minutes).also { block = it }
        }

        for (raw in importLines(text)) {
            if (entries.size >= MAX_ENTRIES) break
            val line = JsText.squash(raw)
            if (line.isEmpty()) {
                flush()
                continue
            }
            if (URL_LINE.matches(line) || emailLine(line) || NOISE_LINE.matches(line)) continue
            val dt = ImportTime.dateTimeLine(line, defaultYear)
            if (dt != null) {
                if (dt.date != null) date = dt.date
                if (dt.minutes != null) pendingMinutes = dt.minutes
                flush()
                continue
            }
            val ctx = CONTEXT_LABEL.find(line)
            if (ctx != null) {
                // Only the first CONTEXT_MAX characters of the speaker text are ever used.
                val names = line.substring(ctx.value.length)
                val b = block
                if (b != null && names.isNotEmpty() && b.contextChars < CONTEXT_MAX) {
                    b.context += names
                    b.contextChars += names.length + 1
                }
                continue
            }
            if (DROP_LABEL.containsMatchIn(line) || roomLike(line)) continue
            val lead = ImportTime.leadTime(line)
            if (lead != null) {
                val b = start(ImportTime.clockMinutes(lead.second))
                val rest = JsText.trim(stripBadge(line.substring(lead.first)))
                if (rest.isNotEmpty()) b.lines += rest
                continue
            }
            val b = block ?: start(pendingMinutes).also { pendingMinutes = null }
            b.lines += line
            // A list block gives one entry per line, so once it can fill the remaining entries, the
            // rest of the text cannot add any.
            if (b.lines.size > 4 && entries.size + b.lines.size >= MAX_ENTRIES) break
        }
        flush()
        return entries
    }

    // ---------------------------------------------------------------------------------------------
    // iCalendar: one entry per VEVENT, from SUMMARY, with DESCRIPTION as the speaker text and
    // DTSTART as the time hint.

    // v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').
    fun icsUnescape(v: String): String {
        val first = StringBuilder(v.length)
        var i = 0
        while (i < v.length) {
            if (v[i] == '\\' && i + 1 < v.length && (v[i + 1] == 'n' || v[i + 1] == 'N')) {
                first.append(' ')
                i += 2
            } else {
                first.append(v[i])
                i++
            }
        }
        val out = StringBuilder(first.length)
        i = 0
        while (i < first.length) {
            if (first[i] == '\\' && i + 1 < first.length && first[i + 1] in ",;\\") {
                out.append(first[i + 1])
                i += 2
            } else {
                out.append(first[i])
                i++
            }
        }
        return out.toString()
    }

    // The content lines of an iCalendar file: a line that starts with a space or a tab continues the
    // one before it (RFC 5545 folding). Each is cut to MAX_LINE characters.
    private fun icsLines(text: String): Sequence<String> = sequence {
        var cur: String? = null
        for (line in importLines(text)) {
            val c = line.firstOrNull()
            val current = cur
            if (current != null && (c == ' ' || c == '\t')) {
                if (current.length < MAX_LINE) cur = (current + line.substring(1)).take(MAX_LINE)
                continue
            }
            if (current != null) yield(current)
            cur = line
        }
        cur?.let { yield(it) }
    }

    // /^NAME\s*$/i on one content line.
    private fun isLine(line: String, name: String): Boolean =
        JsText.startsWithAsciiIgnoreCase(line, name) && (name.length until line.length).all { JsText.isSpace(line[it]) }

    private class Event {
        var summary: String? = null
        var description: String? = null
        var startMs: Long? = null
    }

    fun icsEntries(text: String, conference: ImportConference): List<ImportEntry> {
        val zone = conference.timeZone?.takeIf { it.isNotEmpty() } ?: "UTC"
        val entries = ArrayList<ImportEntry>()
        var ev: Event? = null
        for (line in icsLines(text)) {
            if (entries.size >= MAX_ENTRIES) break
            val current = ev
            if (isLine(line, "BEGIN:VEVENT")) {
                ev = Event()
            } else if (isLine(line, "END:VEVENT")) {
                val summary = current?.summary
                if (current != null && !summary.isNullOrEmpty()) {
                    val split = splitVariants(summary)
                    entries += ImportEntry(listOf(summary) + split.variants, listOf(split.after, current.description ?: "").joinToString(" "), current.startMs, short = true)
                }
                ev = null
            } else if (current != null) {
                val prop = icsProperty(line) ?: continue
                when (prop.first.uppercase()) {
                    "SUMMARY" -> current.summary = JsText.squash(icsUnescape(prop.third))
                    "DESCRIPTION" -> current.description = icsUnescape(prop.third).take(CONTEXT_MAX)
                    "DTSTART" -> current.startMs = icsStart(JsText.trim(prop.third), prop.second, zone)
                }
            }
        }
        return entries
    }

    // /^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/: the name, the parameters and the value of a content line.
    private fun icsProperty(line: String): Triple<String, String, String>? {
        var i = 0
        while (i < line.length && (JsText.isAsciiLetter(line[i]) || line[i] == '-')) i++
        if (i == 0 || i >= line.length) return null
        val name = line.substring(0, i)
        val colon = when (line[i]) {
            ':' -> i
            ';' -> line.indexOf(':', i + 1).takeIf { it >= 0 } ?: return null
            else -> return null
        }
        val value = line.substring(colon + 1)
        // (.*)$ stops at a line terminator, so a value holding one does not match.
        if (value.any { JsText.isLineTerminator(it) }) return null
        return Triple(name, line.substring(i, colon), value)
    }

    private fun icsStart(value: String, params: String, zone: String): Long? {
        // ^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$ (i); an all-day date has no time.
        val utc = value.length == 16 && (value[15] == 'Z' || value[15] == 'z')
        if (value.length != 15 && !utc) return null
        if (!(0 until 8).all { JsText.isDigit(value[it]) } || (value[8] != 'T' && value[8] != 't') || !(9 until 15).all { JsText.isDigit(value[it]) }) return null
        val y = value.substring(0, 4).toInt()
        val mo = value.substring(4, 6).toInt()
        val d = value.substring(6, 8).toInt()
        val h = value.substring(9, 11).toInt()
        val mi = value.substring(11, 13).toInt()
        val s = value.substring(13, 15).toInt()
        if (utc) {
            // Date.UTC rolls every field over: month 13 is January of the next year, and so on.
            val first = ImportTime.daysFromCivil(y + (mo - 1).floorDiv(12), (mo - 1).mod(12) + 1, 1)
            return (first + (d - 1)) * 86_400_000L + h * 3_600_000L + mi * 60_000L + s * 1_000L
        }
        val tzid = tzidOf(params)
        return ImportTime.localToMs(y, mo, d, h * 60 + mi, if (tzid != null && ImportTime.validZone(tzid)) tzid else zone)
    }

    // /;TZID="?([^;:"]+)"?/i: the time zone parameter.
    private fun tzidOf(params: String): String? {
        var from = 0
        while (true) {
            val at = params.indexOf(';', from)
            if (at < 0) return null
            if (JsText.startsWithAsciiIgnoreCase(params, "TZID=", at + 1)) {
                var i = at + 6
                if (params.getOrNull(i) == '"') i++
                val start = i
                while (i < params.length && params[i] != ';' && params[i] != ':' && params[i] != '"') i++
                if (i > start) return params.substring(start, i)
            }
            from = at + 1
        }
    }

    // ---------------------------------------------------------------------------------------------
    // CSV: a title-like column when the header names one, else every cell.

    fun csvDelimiter(line: String): Char? {
        var best: Char? = null
        var bestCount = 0
        for (d in charArrayOf(',', ';', '\t')) {
            val n = line.count { it == d }
            if (n > bestCount) {
                best = d
                bestCount = n
            }
        }
        return best
    }

    /**
     * Rows of cells. A cell keeps its first MAX_LINE characters, and reading stops after
     * MAX_CSV_ROWS rows or MAX_CSV_CELLS cells.
     */
    fun parseCsv(text: String, delim: Char): List<List<String>> {
        val rows = ArrayList<List<String>>()
        var row = ArrayList<String>()
        val cell = StringBuilder()
        var quoted = false
        var cells = 0
        fun add(ch: Char) {
            if (cell.length < MAX_LINE) cell.append(ch)
        }
        var i = 0
        while (i < text.length) {
            val ch = text[i]
            if (quoted) {
                if (ch == '"') {
                    if (i + 1 < text.length && text[i + 1] == '"') {
                        add('"')
                        i++
                    } else {
                        quoted = false
                    }
                } else {
                    add(ch)
                }
            } else if (ch == '"' && cell.isEmpty()) {
                quoted = true
            } else if (ch == delim) {
                row += cell.toString()
                cell.clear()
                if (++cells >= MAX_CSV_CELLS) {
                    rows += row
                    return rows
                }
            } else if (ch == '\n' || ch == '\r') {
                if (ch == '\r' && i + 1 < text.length && text[i + 1] == '\n') i++
                row += cell.toString()
                rows += row
                row = ArrayList()
                cell.clear()
                if (rows.size >= MAX_CSV_ROWS || ++cells >= MAX_CSV_CELLS) return rows
            } else {
                add(ch)
            }
            i++
        }
        if (cell.isNotEmpty() || row.isNotEmpty()) {
            row += cell.toString()
            rows += row
        }
        return rows
    }

    private val TITLE_WORD = Regex("(?<![a-z0-9_])title(?![a-z0-9_])")
    private val SPEAKER_WORD = Regex("(?<![a-z0-9_])(?:speakers?|presenters?|moderators?)(?![a-z0-9_])")

    fun csvEntries(text: String, conference: ImportConference, filename: String): List<ImportEntry> {
        val zone = conference.timeZone?.takeIf { it.isNotEmpty() } ?: "UTC"
        val body = text.removePrefix("﻿")
        val tsv = filename.length >= 4 && JsText.startsWithAsciiIgnoreCase(filename, ".tsv", filename.length - 4)
        val delim = if (tsv) '\t' else csvDelimiter(importFirstLine(body)) ?: ','
        val rows = parseCsv(body, delim).filter { r -> r.any { JsText.trim(it).isNotEmpty() } }
        if (rows.isEmpty()) return emptyList()
        val header = rows[0].map { normHeader(it) }
        fun find(names: List<String>): Int {
            for (n in names) {
                val i = header.indexOf(n)
                if (i != -1) return i
            }
            return -1
        }
        var titleCol = find(TITLE_HEADERS)
        if (titleCol == -1) titleCol = header.indexOfFirst { TITLE_WORD.containsMatchIn(it) }
        if (titleCol == -1) {
            // No title column: every cell is a possible title.
            return rows.asSequence().flatten().take(MAX_ENTRIES).map { cell ->
                val c = JsText.squash(cell)
                val split = splitVariants(c)
                ImportEntry(listOf(c) + split.variants, split.after, null)
            }.toList()
        }
        val speakerCols = header.indices.filter { SPEAKER_WORD.containsMatchIn(header[it]) }
        val startCol = find(listOf("start", "starts", "start time", "start date time", "start datetime", "starts at", "begin", "dtstart", "event start", "start at"))
        val dateCol = find(listOf("start date", "date", "day"))
        val timeCol = find(listOf("start time", "time", "from"))
        return rows.subList(1, minOf(rows.size, MAX_ENTRIES + 1)).map { r ->
            val title = JsText.squash(r.getOrNull(titleCol) ?: "")
            val split = splitVariants(title)
            var hint: Long? = null
            if (startCol != -1 && startCol != timeCol) hint = ImportTime.structuredStart(r.getOrNull(startCol), zone)
            if (hint == null && dateCol != -1) hint = ImportTime.structuredStart(r.getOrNull(dateCol), zone, if (timeCol != -1) r.getOrNull(timeCol) else null)
            ImportEntry(listOf(title) + split.variants, (listOf(split.after) + speakerCols.map { r.getOrNull(it) ?: "" }).joinToString(" "), hint, short = true)
        }
    }

    // ---------------------------------------------------------------------------------------------
    // JSON: Sessionize exports (view/All, view/Sessions), Sched exports and generic arrays. Each
    // object with a title-like string field is one entry; speakers and a start time are read when
    // present.

    private val JSON_TITLE_KEYS = listOf("title", "name", "session", "session_title", "sessionTitle", "talk", "summary", "subject")
    private val JSON_START_KEYS = listOf("startsAt", "start", "event_start", "start_time", "startTime", "dtstart", "starts_at")
    private val SPEAKER_KEYS = listOf("speakers", "speaker", "presenters", "moderators")

    /** Names read per speaker field; the speaker text is cut to CONTEXT_MAX anyway. */
    private const val MAX_SPEAKERS = 100

    private fun jsonTitle(s: String): String = JsText.squash(s.take(MAX_LINE)).take(500)

    private fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

    // A JavaScript value's truthiness, for `v[k] ? [v[k]] : []`.
    private fun truthy(e: JsonElement?): Boolean = when (e) {
        null, JsonNull -> false
        is JsonPrimitive -> when {
            e.isString -> e.content.isNotEmpty()
            e.content == "true" -> true
            e.content == "false" -> false
            else -> e.content.toDoubleOrNull()?.let { it != 0.0 && !it.isNaN() } ?: true
        }
        else -> true
    }

    /**
     * The keys of [o] in the order JavaScript's `Object.keys` lists them for an object JSON.parse
     * built: array indexes ("0", "1", ...) first, in ascending order, then the other keys in the
     * order they were written.
     */
    private fun jsKeys(o: JsonObject): List<String> {
        val keys = o.keys
        if (keys.none { isArrayIndex(it) }) return keys.toList()
        val indexes = keys.filter { isArrayIndex(it) }.sortedBy { it.toLong() }
        return indexes + keys.filterNot { isArrayIndex(it) }
    }

    private fun isArrayIndex(k: String): Boolean =
        k.isNotEmpty() && k.length <= 10 && k.all { JsText.isDigit(it) } && (k == "0" || k[0] != '0') && k.toLong() < 4_294_967_295L

    fun jsonEntries(value: JsonElement, conference: ImportConference): List<ImportEntry> {
        val zone = conference.timeZone?.takeIf { it.isNotEmpty() } ?: "UTC"
        // Sessionize view/All lists speakers by id.
        val speakerNames = HashMap<String, String>()
        var budget = 50_000

        fun collect(v: JsonElement, depth: Int) {
            if (budget-- <= 0 || depth > 8 || (v !is JsonObject && v !is JsonArray)) return
            if (v is JsonArray) {
                for (x in v) {
                    if (budget <= 0) return
                    collect(x, depth + 1)
                }
                return
            }
            v as JsonObject
            val id = v["id"].string()
            val fullName = v["fullName"].string()
            if (id != null && fullName != null) speakerNames[id] = fullName
            for (k in jsKeys(v)) {
                if (budget <= 0) return
                collect(v.getValue(k), depth + 1)
            }
        }
        collect(value, 0)

        fun nameOf(s: JsonElement): String {
            s.string()?.let { return speakerNames[it] ?: it }
            if (s is JsonObject) {
                s["name"].string()?.let { return it }
                s["fullName"].string()?.let { return it }
            }
            return ""
        }

        val entries = ArrayList<ImportEntry>()
        budget = 50_000

        fun walk(v: JsonElement, depth: Int) {
            if (budget-- <= 0 || depth > 8 || entries.size >= MAX_ENTRIES || (v !is JsonObject && v !is JsonArray)) return
            if (v is JsonArray) {
                for (x in v) {
                    if (entries.size >= MAX_ENTRIES) return
                    val s = x.string()
                    if (s != null) entries += ImportEntry(listOf(jsonTitle(s)), "", null, short = true) else walk(x, depth + 1)
                }
                return
            }
            v as JsonObject
            val key = JSON_TITLE_KEYS.firstOrNull { k -> v[k].string()?.let { JsText.trim(it).isNotEmpty() } == true }
            if (key != null) {
                val title = jsonTitle(v[key].string()!!)
                val split = splitVariants(title)
                val speakers = SPEAKER_KEYS.flatMap { k ->
                    val field = v[k]
                    when {
                        field is JsonArray -> field.take(MAX_SPEAKERS)
                        truthy(field) -> listOf(field!!)
                        else -> emptyList()
                    }
                }.joinToString(", ") { nameOf(it) }
                val startKey = JSON_START_KEYS.firstOrNull { v[it].string() != null }
                val hint = startKey?.let { ImportTime.structuredStart(v[it].string(), zone) }
                entries += ImportEntry(listOf(title) + split.variants, listOf(split.after, speakers).joinToString(" "), hint, short = true)
            }
            for (k in jsKeys(v)) {
                if (budget <= 0 || entries.size >= MAX_ENTRIES) return
                if (k !in SPEAKER_KEYS) walk(v.getValue(k), depth + 1)
            }
        }
        walk(value, 0)
        return entries
    }

    // ---------------------------------------------------------------------------------------------
    // Candidates. The first preferred text of every entry comes first, then the second of every
    // entry, and so on, so a long file cannot crowd out later entries' best lines. Candidates need
    // three words, at least two of them content words. The preferred text of an entry that is
    // clearly one schedule item may have two words. exact is set only with three content words, so a
    // short phrase cannot claim an exact match.

    private val EN_STOP = ImportAnalysis.STOPWORDS

    private const val LEAD_KEEP = "\"'“‘(["
    private const val TRAILING = "-–—|•·:,;"

    /**
     * A candidate text (`cleanCandidate`): white space collapsed, leading punctuation and a leading
     * time with its badge removed, cut to TITLE_MAX characters, then trailing punctuation removed.
     * The cut comes before the strip, as there, because the strip would otherwise run over a long
     * run of punctuation.
     */
    fun cleanCandidate(s: String): String {
        var t = JsText.collapse(s.take(MAX_ITEM))
        var i = 0
        while (i < t.length && !JsText.isWordChar(t[i]) && t[i] !in LEAD_KEEP) i++
        t = t.substring(i)
        val lead = ImportTime.leadTime(t)
        if (lead != null) t = stripBadge(t.substring(lead.first))
        t = t.take(TITLE_MAX)
        var end = t.length
        while (end > 0 && (JsText.isSpace(t[end - 1]) || t[end - 1] in TRAILING)) end--
        return t.substring(0, end)
    }

    fun candidates(entries: List<ImportEntry>): List<ImportCandidate> {
        val out = ArrayList<ImportCandidate>()
        val byKey = HashMap<String, ImportCandidate>()
        val rounds = entries.maxOfOrNull { it.variants.size } ?: 0
        var v = 0
        while (v < rounds && out.size < MAX_CANDIDATES) {
            var i = 0
            while (i < entries.size && out.size < MAX_CANDIDATES) {
                val e = entries[i]
                if (v < e.variants.size) {
                    candidate(e, v, i, byKey)?.let { out += it }
                }
                i++
            }
            v++
        }
        return out
    }

    private fun candidate(e: ImportEntry, v: Int, i: Int, byKey: HashMap<String, ImportCandidate>): ImportCandidate? {
        val text = cleanCandidate(e.variants[v])
        val words = text.split(' ').filter { w -> w.any { JsText.isWordChar(it) } }
        if (words.size < (if (v == 0 && e.short) 2 else 3) || words.size > 40) return null
        val content = words.count { w -> w.lowercase().filter { JsText.isWordChar(it) } !in EN_STOP }
        if (content < 2) return null
        val key = JsText.wordKey(text)
        val seen = byKey[key]
        if (seen != null) {
            seen.entries += i
            return null
        }
        val c = ImportCandidate(text, linkedSetOf(i), content >= 3, JsText.collapse(e.context).take(CONTEXT_MAX), e.hintMs)
        byKey[key] = c
        return c
    }
}
