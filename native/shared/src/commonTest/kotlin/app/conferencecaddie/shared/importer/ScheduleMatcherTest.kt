package app.conferencecaddie.shared.importer

import app.conferencecaddie.shared.importer.ImportFixtures.TALKS
import app.conferencecaddie.shared.importer.ImportFixtures.file
import app.conferencecaddie.shared.importer.ImportFixtures.ics
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The matcher's labels and order, the analysis it rests on, and a schedule read against another
 * conference. The stems and analysed words were taken from worker/src/talks/analyze.js.
 */
class ScheduleMatcherTest {
    private val bundle = ImportFixtures.bundle()

    private fun import(input: ImportInput, over: app.conferencecaddie.shared.bundle.TalkBundle = bundle): ImportResult {
        val prepared = assertIs<ScheduleImport.Checked.Ok>(ScheduleImport.check(input)).prepared
        return ScheduleImport.onDevice(prepared, over)
    }

    private fun ImportResult.labels() = matched.map { it.talk.title to it.confidence }

    @Test
    fun eachLabelComesFromTheClausesThatMatched() {
        val csv = listOf(
            "Title,Speakers,Start",
            "Inside the Kubernetes Scheduler,,",
            "Kubernetes Scheduler from the Inside,Xavier Dupont,",
            "Zero Trust Mesh Practice Service,,2099-11-11 10:00",
            "Rust Kubernetes Operators Workshop,,",
        ).joinToString("\n")
        val r = import(file(csv, "picks.csv"))
        assertEquals(
            listOf(
                "Inside the Kubernetes Scheduler" to ImportConfidence.ExactTitle,
                "Zero Trust Service Mesh in Practice" to ImportConfidence.TitleAndTime,
                "Rust Operators for Kubernetes" to ImportConfidence.TitleWords,
            ),
            r.labels(),
            "the scheduler talk keeps its best label across both rows",
        )
    }

    @Test
    fun theSpeakerLabelNeedsTwoOfTheSpeakersWords() {
        val r = import(file("Title,Speakers\nKubernetes Scheduler from the Inside,Xavier Dupont\n", "a.csv"))
        assertEquals(listOf("Inside the Kubernetes Scheduler" to ImportConfidence.TitleAndSpeaker), r.labels())
        val one = import(file("Title,Speakers\nKubernetes Scheduler from the Inside,Xavier Someone\n", "a.csv"))
        assertEquals(listOf("Inside the Kubernetes Scheduler" to ImportConfidence.TitleWords), one.labels())
    }

    @Test
    fun theTimeLabelNeedsTheStartWithinTheMinute() {
        fun at(dtstart: String) = import(file(ics("DTSTART:$dtstart", "SUMMARY:Zero Trust Mesh Practice Service"), "x.ics")).labels().single().second
        assertEquals(ImportConfidence.TitleAndTime, at("20991111T170000Z"))
        assertEquals(ImportConfidence.TitleWords, at("20991111T170100Z"))
        assertEquals(ImportConfidence.TitleWords, at("20991111T165900Z"))
    }

    @Test
    fun matchesFollowTheFileAndEntriesWithoutAMatchAreCounted() {
        val r = import(
            ImportInput.Text(
                "Zero Trust Service Mesh in Practice\n\nNothing here matches any talk\n\nRust Operators for Kubernetes\n\nInside the Kubernetes Scheduler\n\nAlso not a talk at all\n",
            ),
        )
        assertEquals(listOf(TALKS[3], TALKS[1], TALKS[0]).map { it.title }, r.matched.map { it.talk.title })
        assertEquals(2, r.unmatchedCount)
        assertEquals("Zero Trust Service Mesh in Practice", r.matched[0].excerpt)
    }

    @Test
    fun aScheduleOfOneConferenceFindsNothingAtAnother() {
        val other = ImportFixtures.bundle(
            ImportFixtures.conference(slug = "otherconf-2099", zone = "Africa/Nairobi"),
            listOf(
                ImportFixtures.talk("otherconf-2099", 1, "Building Agents with the Model Context Protocol", listOf("Wanjiru Kamau"), "2099-11-11T09:00:00+03:00"),
                ImportFixtures.talk("otherconf-2099", 2, "Securing MCP Servers in Production", listOf("Otieno Odhiambo"), "2099-11-11T10:00:00+03:00"),
            ),
        )
        val text = TALKS.joinToString("\n\n") { "${it.title}\nSpeakers: ${it.speakers.joinToString(", ")}" }
        assertEquals(TALKS.map { it.title }, import(ImportInput.Text(text)).matched.map { it.talk.title })
        val r = import(ImportInput.Text(text), other)
        assertEquals(emptyList(), r.matched)
        assertEquals(4, r.unmatchedCount)
    }

    @Test
    fun breaksAndEventsAreNeverMatched() {
        val talks = TALKS + ImportFixtures.talk(ImportFixtures.EVENT, 9, "Lunch Break for Everyone Here", emptyList(), "2099-11-11T12:00:00-07:00", kind = "break") +
            ImportFixtures.talk(ImportFixtures.EVENT, 10, "Kubernetes Scheduler Expo Booth Crawl", emptyList(), "2099-11-11T18:00:00-07:00", kind = "ambient")
        val r = import(ImportInput.Text("Lunch Break for Everyone Here\n\nKubernetes Scheduler Expo Booth Crawl\n"), ImportFixtures.bundle(talks = talks))
        assertEquals(emptyList(), r.matched)
    }

    @Test
    fun excerptsAreCutAtAWordAsTheWorkerCutsThem() {
        val long = "Inside the Kubernetes Scheduler " + "with many more words after the title ".repeat(10)
        assertEquals(
            "Inside the Kubernetes Scheduler with many more words after the title with many more words after the title " +
                "with many more words after the title with many more…",
            ScheduleMatcher.excerpt(long),
        )
        assertEquals(161, ScheduleMatcher.excerpt("x".repeat(200)).length, "no space late enough: a plain cut")
        assertEquals("short", ScheduleMatcher.excerpt("short"))
    }

    @Test
    fun thePorterStemmerGivesTheWorkersStems() {
        val stems = mapOf(
            "scheduling" to "schedul", "scheduler" to "schedul", "operators" to "oper", "running" to "run", "generalization" to "gener",
            "sleeping" to "sleep", "yes" to "ye", "yelling" to "yell", "ponies" to "poni", "caresses" to "caress", "agreed" to "agre",
            "hopping" to "hop", "filing" to "file", "happy" to "happi", "relational" to "relat", "conditional" to "condit",
            "valency" to "valenc", "hesitancy" to "hesit", "digitizer" to "digit", "conformabli" to "conform", "radicalli" to "radic",
            "differentli" to "differ", "vileli" to "vile", "analogousli" to "analog", "vietnamization" to "vietnam",
            "predication" to "predic", "operator" to "oper", "feudalism" to "feudal", "decisiveness" to "decis",
            "hopefulness" to "hope", "callousness" to "callous", "formaliti" to "formal", "sensitiviti" to "sensit",
            "sensibiliti" to "sensibl", "triplicate" to "triplic", "formative" to "form", "formalize" to "formal",
            "electriciti" to "electr", "electrical" to "electr", "hopeful" to "hope", "goodness" to "good", "revival" to "reviv",
            "allowance" to "allow", "inference" to "infer", "airliner" to "airlin", "gyroscopic" to "gyroscop",
            "adjustable" to "adjust", "defensible" to "defens", "irritant" to "irrit", "replacement" to "replac",
            "adjustment" to "adjust", "dependent" to "depend", "adoption" to "adopt", "homologou" to "homolog",
            "communism" to "commun", "activate" to "activ", "angulariti" to "angular", "homologous" to "homolog",
            "effective" to "effect", "bowdlerize" to "bowdler", "probate" to "probat", "rate" to "rate", "cease" to "ceas",
            "controll" to "control", "roll" to "roll", "kubernetes" to "kubernet", "observability" to "observ", "gitops" to "gitop",
            "ebpf" to "ebpf", "café" to "café", "sky" to "sky", "dying" to "dy", "lying" to "ly",
        )
        assertEquals(stems, stems.keys.associateWith { PorterStemmer.stem(it) })
    }

    @Test
    fun wordsAreFoldedAndAnalysedAsTheWorkerDoes() {
        assertEquals(
            listOf("cafe", "resum", "naiv", "approach", "observ", "istanbul", "sehir", "ﬁle", "2nd"),
            ImportAnalysis.analyzed("Café Résumé: Naïve Approaches to Observability — the İstanbul ŞEHİR ﬁle 2nd"),
        )
        assertEquals(listOf("ⅻ", "½", "٣", "x²"), ImportAnalysis.words("Ⅻ ½ ٣ x²"))
        assertEquals(listOf(1, 2, 3, 3, 3, 4, 5, 6, 9), listOf(1, 2, 3, 4, 5, 6, 7, 8, 12).map { ImportAnalysis.minimumShouldMatch(it, "3<75%") })
    }
}
