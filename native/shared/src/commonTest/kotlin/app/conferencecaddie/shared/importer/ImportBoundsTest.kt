package app.conferencecaddie.shared.importer

import app.conferencecaddie.shared.importer.ImportFixtures.TALKS
import app.conferencecaddie.shared.importer.ImportFixtures.file
import app.conferencecaddie.shared.importer.ImportFixtures.ics
import app.conferencecaddie.shared.importer.ImportFixtures.startOf
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.test.fail
import kotlin.time.TimeSource

/**
 * The cases of test/import-bounds.test.mjs, the server's tests of the import's bounds, run against
 * the device's import. Where the server's test reads the searches sent to Elasticsearch, these read
 * the candidates (their text, speaker text and time hint), which are what those searches carry; the
 * matches come from the device's matcher over the same four talks.
 *
 * - Inputs that made a regular expression backtrack for 10 to 20 seconds on the server each finish
 *   in under half a second.
 * - The server runs seven worst-case 5 MB uploads in a child process with a 64 MB heap. A heap cap
 *   cannot be set from a common test, so here each must finish, with the parsers stopping at their
 *   bounds (at most 3,000 entries and 300 candidates); reading by index rather than splitting the
 *   whole file is what keeps the memory down, and the code is the same.
 * - The bounds keep the results of ordinary files.
 * - Pasted text with file name and type hints, as the Worker accepts it, reads as the server reads it.
 *   The HTTP validation of the hints (400 for a bad hint or an unknown key) has no device equivalent;
 *   the device sends hints only through [ServerScheduleImport], which cuts them to the route's limits.
 */
class ImportBoundsTest {
    private val matcher = ScheduleMatcher(TALKS)

    private class Run(val candidates: List<ImportCandidate>, val result: ImportResult, val ms: Long)

    private fun prepared(input: ImportInput): ScheduleImport.Prepared = when (val c = ScheduleImport.check(input)) {
        is ScheduleImport.Checked.Ok -> c.prepared
        is ScheduleImport.Checked.Refused -> fail("refused: ${c.reason}")
    }

    private fun run(prepared: ScheduleImport.Prepared): Run {
        val mark = TimeSource.Monotonic.markNow()
        val candidates = ScheduleImport.candidatesOf(prepared, ImportFixtures.importConference)
        val result = matcher.run(candidates, prepared.text.length)
        return Run(candidates, result, mark.elapsedNow().inWholeMilliseconds)
    }

    private fun run(input: ImportInput): Run = run(prepared(input))

    private fun text(t: String) = run(ImportInput.Text(t))

    private fun hinted(t: String, filename: String = "", mime: String = "") = run(ScheduleImport.Prepared(t, filename, mime, isFile = false))

    private fun Run.titles() = result.matched.map { it.talk.title }

    private val two = listOf("Inside the Kubernetes Scheduler", "Rust Operators for Kubernetes")

    // ---------------------------------------------------------------------------------------------
    // Inputs that used to backtrack finish quickly.

    private val k200 = 200_000

    private val backtracking: List<Pair<String, ImportInput>> by lazy {
        listOf(
            "an 8 KB pasted line of \"@.\"" to ImportInput.Text("@.".repeat(4000) + " x"),
            "a pasted 150 KB run of colons" to ImportInput.Text("a" + ":".repeat(150_000) + "b"),
            "a pasted 150 KB run of spaces" to ImportInput.Text("a" + " ".repeat(150_000) + "b"),
            "an iCalendar SUMMARY of 200 KB of spaces" to file(ics("DTSTART:20991110T173000Z", "SUMMARY:a${" ".repeat(k200)}b"), "s.ics"),
            "an iCalendar SUMMARY of 200 KB of colons" to file(ics("DTSTART:20991110T173000Z", "SUMMARY:a${":".repeat(k200)}b"), "s.ics"),
            "an iCalendar DESCRIPTION of 200 KB of \"@.\"" to file(ics("SUMMARY:Inside the Kubernetes Scheduler", "DESCRIPTION:${"@.".repeat(k200 / 2)} x"), "s.ics"),
            "a CSV title cell of 200 KB of spaces" to file("Title,Speakers\r\n\"a${" ".repeat(k200)}b\",x\r\n", "s.csv"),
            "a CSV title cell of 200 KB of colons" to file("Title,Speakers\r\n\"a${":".repeat(k200)}b\",x\r\n", "s.csv"),
            "a headerless CSV cell of 200 KB of spaces" to file("x;\"a${" ".repeat(k200)}b\"\n", "s.csv"),
            "a JSON title of 200 KB of spaces" to file("[{\"title\":\"a${" ".repeat(k200)}b\"}]", "s.json"),
        )
    }

    @Test
    fun inputsThatUsedToBacktrackFinishQuickly() {
        // The first import loads and compiles everything once, as the server's module was loaded
        // before its timings.
        text("Inside the Kubernetes Scheduler")
        // The bound is relative to an ordinary input of the same size, so a slow runner (a debug
        // Kotlin/Native build on a shared machine) slows both: a pattern that backtracks takes seconds,
        // a hundred times or more what reading 200 KB of words takes, while a slow machine does not.
        val baseline = (1..3).minOf { run(ImportInput.Text("Inside the Kubernetes Scheduler ".repeat(6_000))).ms }
        val limit = maxOf(500L, baseline * 20)
        val slow = ArrayList<String>()
        for ((name, input) in backtracking) {
            val r = run(input)
            if (r.ms >= limit) slow += "$name took ${r.ms} ms (limit $limit ms, baseline $baseline ms)"
        }
        assertTrue(slow.isEmpty(), slow.joinToString("; "))
    }

    @Test
    fun aLongTitleLineStillGivesACandidateOfAtMost300Characters() {
        val r = text("Inside the Kubernetes Scheduler ${"x".repeat(5000)}::::\n")
        assertTrue(r.candidates.isNotEmpty() && r.candidates.all { it.text.length <= 300 }, r.candidates.map { it.text.length }.toString())
    }

    // ---------------------------------------------------------------------------------------------
    // A worst-case 5 MB upload stays inside the bounds.

    private fun fiveMb(prefix: String, unit: String, suffix: String, filename: String): ImportInput.File {
        val size = 5 * 1024 * 1024 - prefix.length - suffix.length
        val sb = StringBuilder(5 * 1024 * 1024)
        sb.append(prefix)
        repeat(size / unit.length) { sb.append(unit) }
        sb.append(suffix)
        return file(sb.toString(), filename)
    }

    private fun bounded(name: String, input: ImportInput.File) {
        val p = prepared(input)
        val detected = ScheduleParser.detect(p.text, p.filename, p.mime)
        val entries = ScheduleParser.entries(p.text, detected, p.filename, ImportFixtures.importConference)
        assertTrue(entries.size <= MAX_ENTRIES, "$name: ${entries.size} entries")
        val r = run(p)
        assertTrue(r.candidates.size <= MAX_CANDIDATES, "$name: ${r.candidates.size} candidates")
    }

    @Test
    fun plainTextOf1point7MillionShortLinesAndNoBlankLine() = bounded("short lines", fiveMb("", "ab\n", "", "s.txt"))

    @Test
    fun plainTextOfOne5MbLine() = bounded("one line", fiveMb("", "ab ", "", "s.txt"))

    @Test
    fun plainTextOfATitleAndAMillionByLines() = bounded("By lines", fiveMb("Inside the Kubernetes Scheduler\n", "By:ab\n", "", "s.txt"))

    @Test
    fun csvWithoutAHeaderOf1point7MillionCells() = bounded("headerless CSV", fiveMb("", "ab,", "", "s.csv"))

    @Test
    fun csvWithOne5MbQuotedCell() = bounded("quoted cell", fiveMb("Title,Speakers\n\"", "ab", "\"\n", "s.csv"))

    @Test
    fun iCalendarWithOneEventOf1point7MillionLines() = bounded(
        "long event",
        fiveMb("BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Inside the Kubernetes Scheduler\n", "ab\n", "END:VEVENT\nEND:VCALENDAR\n", "s.ics"),
    )

    @Test
    fun jsonArrayOfAMillionStrings() = bounded("JSON strings", fiveMb("[", "\"ab\",", "\"x\"]", "s.json"))

    // ---------------------------------------------------------------------------------------------
    // The bounds keep the results of ordinary files.

    @Test
    fun aPastedListOfTitleSpeakerDayTimeLines() {
        val r = text(
            listOf(
                "My picks",
                "Inside the Kubernetes Scheduler — Xavier Dupont — Wed 15:00",
                "Rust Operators for Kubernetes — Arjun Mehta — Thu 9:30",
                "Running Postgres on Kubernetes Without Losing Sleep — Alice Moreau, Bjorn Ek — Tue 10:30",
                "Zero Trust Service Mesh in Practice — Pablo Ruiz — Wed 10:00",
                "A Talk That Is Not On The Schedule — Nobody — Thu 13:00",
            ).joinToString("\n"),
        )
        assertEquals(TALKS.map { it.title }, r.titles())
        assertEquals(1, r.result.unmatchedCount)
        // A list of more than four lines is one entry per line: the line, then the part before the
        // speaker suffix, then the first part.
        assertEquals("Inside the Kubernetes Scheduler — Xavier Dupont — Wed 15:00", r.candidates[0].text)
        assertTrue(r.candidates.any { it.text == "Inside the Kubernetes Scheduler - Xavier Dupont" && it.context == "Wed 15:00" })
        assertTrue(r.candidates.any { it.text == "Inside the Kubernetes Scheduler" })
    }

    @Test
    fun emailLinesAreDroppedAndOtherLinesWithAnAtAreKept() {
        val r = text("Inside the Kubernetes Scheduler\nxavier.dupont@example.com\n\nRust Operators for Kubernetes\nfirst.last@localhost")
        assertEquals(
            listOf("Inside the Kubernetes Scheduler", "Rust Operators for Kubernetes first.last@localhost", "Rust Operators for Kubernetes"),
            r.candidates.map { it.text },
        )
    }

    @Test
    fun wrappedSchedStyleItemsKeepTheirTimeHintAndSpeakerText() {
        val r = text("Wednesday, November 11, 2099\n\n3:00pm – 3:30pm K Inside the Kubernetes\nScheduler\nSpeakers: Xavier Dupont\nRoom 250\n")
        val c = r.candidates[0]
        assertEquals(Triple("Inside the Kubernetes Scheduler", "Xavier Dupont", startOf(1)), Triple(c.text, c.context, c.hintMs))
        assertEquals(listOf("Inside the Kubernetes Scheduler"), r.titles())
    }

    @Test
    fun speakerTextStopsGrowingOnceItIsLongEnoughAndStillHoldsTheFirstNames() {
        val r = run(file("Inside the Kubernetes Scheduler\n" + "Speakers: Xavier Dupont\n".repeat(10_000), "speakers.txt"))
        assertEquals(List(30) { "Xavier Dupont" }.joinToString(" ").take(300), r.candidates[0].context)
    }

    @Test
    fun aBlockOfMoreLinesThanTheEntryLimitGivesExactly3000Entries() {
        val r = run(file("alpha beta gamma\n".repeat(5000), "list.txt"))
        assertEquals(1, r.candidates.size)
        assertEquals(3000, r.result.unmatchedCount)
    }

    @Test
    fun anICalendarEventWithFoldedLinesATzidStartAndASpeakerSuffix() {
        val r = run(
            file(
                ics(
                    "DTSTART;TZID=America/Denver:20991111T150000",
                    "SUMMARY:Inside the Kubernetes\r\n  Scheduler   -   Xavier\r\n  Dupont",
                    "DESCRIPTION:Speakers: Xavier Dupont\\, Example Inc.",
                ),
                "my.ics",
            ),
        )
        assertEquals(listOf("Inside the Kubernetes Scheduler - Xavier Dupont", "Inside the Kubernetes Scheduler"), r.candidates.map { it.text })
        assertEquals("Xavier Dupont Speakers: Xavier Dupont, Example Inc.", r.candidates[0].context)
        assertEquals(startOf(1), r.candidates[0].hintMs)
        assertEquals(listOf("Inside the Kubernetes Scheduler"), r.titles())
    }

    @Test
    fun csvCellsWithRunsOfSpacesStillSplitIntoTitleAndSpeaker() {
        val csv = "Title,Speakers,Start\r\n\"Inside   the Kubernetes Scheduler   -   Xavier Dupont\",Xavier Dupont,2099-11-11 15:00\r\n" +
            "Rust Operators for Kubernetes,Arjun Mehta,2099-11-12T16:30:00Z\r\n"
        val r = run(file(csv, "export.csv"))
        assertEquals(
            listOf(
                Triple("Inside the Kubernetes Scheduler - Xavier Dupont", "Xavier Dupont Xavier Dupont", startOf(1)),
                Triple("Rust Operators for Kubernetes", "Arjun Mehta", startOf(2)),
                Triple("Inside the Kubernetes Scheduler", "Xavier Dupont Xavier Dupont", startOf(1)),
            ),
            r.candidates.map { Triple(it.text, it.context, it.hintMs) },
        )
        assertEquals(two, r.titles())
    }

    @Test
    fun sessionizeStyleJsonWithSpeakersListedById() {
        val json = """{"sessions":[{"id":"1","title":"Rust Operators for Kubernetes","speakers":["s1"],"startsAt":"2099-11-12T09:30:00"}],""" +
            """"speakers":[{"id":"s1","fullName":"Arjun Mehta"}]}"""
        val r = run(file(json, "sessionize.json"))
        assertEquals(listOf(Triple("Rust Operators for Kubernetes", "Arjun Mehta", startOf(2))), r.candidates.map { Triple(it.text, it.context, it.hintMs) })
        assertEquals(listOf("Rust Operators for Kubernetes"), r.titles())
    }

    // ---------------------------------------------------------------------------------------------
    // Pasted text with file name and type hints, as the Worker accepts it.

    private val csvText = "Session,Speaker\nInside the Kubernetes Scheduler,Xavier Dupont\nRust Operators for Kubernetes,Arjun Mehta\n"

    @Test
    fun textWithACsvHintReadsAsCsv() = assertEquals(two, hinted(csvText, "my.csv", "text/csv").titles())

    @Test
    fun textWithATsvHintReadsAsTabSeparatedEvenWhenCommasOutnumberTabsInTheHeader() {
        val t = "Session, title\tSpeaker, name, role\nInside the Kubernetes Scheduler\tXavier Dupont\nRust Operators for Kubernetes\tArjun Mehta\n"
        assertTrue("Rust Operators for Kubernetes" in hinted(t, "my.tsv").titles())
    }

    @Test
    fun textWithAnIcsHintAndAnICalendarBodyReadsAsICalendar() =
        assertEquals(listOf(TALKS[0].title), hinted(ics("SUMMARY:Inside the Kubernetes Scheduler", "DTSTART:20991111T220000Z"), "cal.ics", "text/calendar").titles())

    @Test
    fun textWithoutHintsBehavesAsBefore() = assertEquals(two, text("My picks\nInside the Kubernetes Scheduler\nRust Operators for Kubernetes\n").titles())

    @Test
    fun theBrowserExtractedPdfShapeIsPlainText() =
        assertEquals(two, hinted("Inside the Kubernetes Scheduler\nRust Operators for Kubernetes\n", "schedule.pdf", "text/plain").titles())

    @Test
    fun anUnexpectedMimeFallsBackToContentDetection() =
        assertEquals(two, hinted("Inside the Kubernetes Scheduler\nRust Operators for Kubernetes\n", "x.bin", "application/octet-stream").titles())

    @Test
    fun sizeLimitsStillApply() {
        assertEquals(ImportRefusal.PasteTooLong, assertIs<ScheduleImport.Checked.Refused>(ScheduleImport.check(ImportInput.Text("a".repeat(200_001)))).reason)
        assertEquals(ImportRefusal.PasteEmpty, assertIs<ScheduleImport.Checked.Refused>(ScheduleImport.check(ImportInput.Text("   "))).reason)
        assertIs<ScheduleImport.Checked.Ok>(ScheduleImport.check(ImportInput.Text("a".repeat(200_000))))
    }
}
