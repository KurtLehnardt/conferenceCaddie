package app.conferencecaddie.shared.search

import app.conferencecaddie.shared.bundle.IsoTime
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.fixtures.Fixtures
import app.conferencecaddie.shared.fixtures.Fixtures.A
import app.conferencecaddie.shared.fixtures.Fixtures.B
import app.conferencecaddie.shared.fixtures.Fixtures.C
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Instant
import kotlinx.coroutines.test.runTest

// Keyword search over the fixture bundle, with golden expectations worked out from its four items
// (docs/contracts/talk-bundle.md, Fixture): 1001 "Securing MCP servers in production" (10:00, Hall A
// Room 1, Security, Lightning), 1002 "Kubernetes for beginners" (10:00, Hall A Room 2), the lunch
// break (12:00 to 13:00) and 1003 "Energy-aware Kubernetes scheduling" (13:30, Hall B, slides), all
// on Monday 2 March 2099 in Europe/Amsterdam. The cases follow the server's search behaviour and
// the talk checks of scripts/smoke.mjs (m1, m2, n1, n2, v1, v2).
class SearchTest {
    private val bundle = TalkBundle.decode(Fixtures.HASH, Fixtures.files.getValue("bundle.json"))!!
    private val database = CaddieDatabase.open(":memory:")
    private val scope = "https://caddie.example\n${Fixtures.SLUG}"
    private var nowMs = IsoTime.epochMillis("2099-03-02T09:15:00Z")!!
    private val search = TalkSearch(bundle, scope, database, now = { Instant.fromEpochMilliseconds(nowMs) })

    @AfterTest
    fun close() = database.close()

    private suspend fun run(request: SearchRequest): SearchResult {
        if (database.installedBundle(scope) == null) database.install(scope, bundle, 0)
        return search.search(request)
    }

    private suspend fun ids(query: String, request: SearchRequest = SearchRequest()) = run(request.copy(query = query)).talks.map { it.talkId }

    @Test
    fun kubernetesSchedulerFindsTheSchedulingTalkThroughStemming() = runTest {
        val r = run(SearchRequest(query = "kubernetes scheduler"))
        assertEquals(listOf(C), r.talks.map { it.talkId }, "two terms must both match; scheduler and scheduling share a stem")
        assertEquals("kubernetes scheduler", r.searchText)
        assertEquals(listOf("track" to "Kubernetes"), r.suggestions.map { it.kind to it.value })
    }

    @Test
    fun oneTermRanksAndBrowseModeSortsByStart() = runTest {
        assertEquals(listOf(B, C), ids("kubernetes"), "the shorter document with the term in its title ranks first")
        assertEquals(listOf(A, B, C), ids(""), "browse mode: by start, then talk id; the lunch break never appears")
        assertEquals(emptyList(), ids("lunch"), "schedule filler never matches")
        assertEquals(emptyList(), ids("the"), "a text of stop words only matches nothing")
        assertEquals(listOf(A), ids("mcp"))
        assertEquals(listOf(A), ids("audit logs"), "the abstract is searched")
        assertEquals(listOf(C), ids("linus"), "speakers are searched")
        assertEquals(listOf(B), ids("maintainer"), "taglines are searched")
    }

    @Test
    fun longerQueriesNeedSixtyPercentOfTheirTerms() = runTest {
        // Three terms: floor(3 x 0.6) = 1 must match.
        assertEquals(setOf(B, C), ids("kubernetes beginners energy").toSet())
        // Five terms: 3 must match. Only 1003 has energy, kubernetes and scheduling.
        assertEquals(listOf(C), ids("energy kubernetes scheduling banana apple"))
        assertEquals(emptyList(), ids("energy banana apple cherry kubernetes durian"))
    }

    @Test
    fun theTermsMustMatchWithinOneField() = runTest {
        // The server's best_fields query counts minimum_should_match per field, so two terms that
        // are only found in different fields of a talk do not match it.
        assertEquals(emptyList(), ids("kubernetes maintainer"), "1002: kubernetes in the title, maintainer in a tagline")
        assertEquals(emptyList(), ids("energy pods"), "1003: energy in the title, pods in the abstract")
        assertEquals(emptyList(), ids("linus scheduling"), "1003: a speaker and a title word")
        assertEquals(listOf(A), ids("mcp audit"), "1001's abstract holds both")
        assertEquals(listOf(C), ids("ada linus"), "1003's speakers hold both")
        // With three terms one is enough, wherever it is.
        assertEquals(setOf(B, C), ids("kubernetes maintainer pods").toSet())
    }

    @Test
    fun tuesdayAfternoonOnAMondayConference() = runTest {
        // m1 on the fixture: the conference has no Tuesday, so "tuesday" stays in the text, and
        // "afternoon" is recognised and filters.
        val r = run(SearchRequest(query = "kubernetes tuesday afternoon"))
        assertEquals("kubernetes tuesday", r.searchText)
        assertEquals(listOf("afternoon" to true), r.timePhrases.map { it.key to it.applied })
        assertEquals(emptyList(), r.talks, "both remaining terms must match")
        val afternoon = run(SearchRequest(query = "kubernetes afternoon"))
        assertEquals("kubernetes", afternoon.searchText)
        assertEquals(listOf(C), afternoon.talks.map { it.talkId }, "only 1003 starts at or after 12:00")
        val removed = run(SearchRequest(query = "kubernetes afternoon", ignorePhrases = setOf("afternoon")))
        assertEquals(listOf("afternoon" to false), removed.timePhrases.map { it.key to it.applied })
        assertEquals(listOf(B, C), removed.talks.map { it.talkId }, "a removed phrase leaves the text but filters nothing")
    }

    @Test
    fun mondayMorningAndLunchUseTheConferencesOwnSchedule() = runTest {
        val monday = run(SearchRequest(query = "on monday in the morning"))
        assertEquals("", monday.searchText, "lead-in words leave with their phrase, and an empty remainder browses")
        assertEquals(listOf("monday", "morning"), monday.timePhrases.map { it.key })
        assertEquals(listOf("2099-03-02"), monday.timePhrases.first().days)
        assertEquals(listOf(A, B), monday.talks.map { it.talkId })
        assertEquals(listOf(A, B), ids("before lunch"), "lunch starts at 12:00")
        assertEquals(listOf(C), ids("after lunch"), "lunch ends at 13:00; 1003 starts at 13:30")
        assertEquals(listOf(A, B, C), ids("day 1"))
    }

    @Test
    fun afterLunchDay2AndUnknownDays() = runTest {
        // m2 on the fixture: a one-day conference has no day 2, so "day 2" stays in the text.
        val r = run(SearchRequest(query = "after lunch day 2"))
        assertEquals("day 2", r.searchText)
        assertEquals(listOf("after-lunch"), r.timePhrases.map { it.key })
        val unknown = run(SearchRequest(query = "day 9 friday"))
        assertEquals(emptyList(), unknown.timePhrases)
        assertEquals("day 9 friday", unknown.searchText)
    }

    @Test
    fun filtersAndFacetCounts() = runTest {
        val kubernetes = run(SearchRequest(tracks = setOf("Kubernetes")))
        assertEquals(listOf(B, C), kubernetes.talks.map { it.talkId })
        assertEquals(listOf(FacetCount("Kubernetes", 2), FacetCount("🔐 Security", 1)), kubernetes.facets.track, "a group's counts ignore its own selection")
        assertEquals(listOf(FacetCount("2099-03-02", 2)), kubernetes.facets.day)
        assertEquals(listOf(FacetCount("Advanced", 1), FacetCount("Beginner", 1)), kubernetes.facets.level)
        assertEquals(listOf(FacetCount(true, 1), FacetCount(false, 1)), kubernetes.facets.hasSlides)
        assertEquals(listOf(FacetCount("Talk", 1)), kubernetes.facets.tags.single().values)
        assertEquals("Format", kubernetes.facets.tags.single().group)

        assertEquals(listOf(C), ids("", SearchRequest(hasSlides = true)))
        assertEquals(listOf(A, B), ids("", SearchRequest(hasSlides = false)))
        assertEquals(listOf(A), ids("", SearchRequest(tags = mapOf("Format" to setOf("Lightning")))))
        assertEquals(listOf(A, C), ids("", SearchRequest(tags = mapOf("Format" to setOf("Lightning", "Talk")))), "values of one group are alternatives")
        assertEquals(listOf(B), ids("", SearchRequest(levels = setOf("Beginner"))))
        assertEquals(listOf(A, B, C), ids("", SearchRequest(day = "2099-03-02")))
        assertEquals(emptyList(), ids("", SearchRequest(day = "2099-03-03")))
        assertEquals(listOf(B, C), ids("", SearchRequest(startAfter = 600, startBefore = 900, tracks = setOf("Kubernetes"))))
        assertEquals(listOf(C), ids("", SearchRequest(startAfter = 601)))

        // A selected value with no matches is still listed, with 0.
        val none = run(SearchRequest(query = "mcp", tracks = setOf("Kubernetes")))
        assertEquals(emptyList(), none.talks)
        assertTrue(FacetCount("Kubernetes", 0) in none.facets.track)
        assertTrue(FacetCount("🔐 Security", 1) in none.facets.track)
    }

    @Test
    fun suggestionsAreOfferedNeverApplied() = runTest {
        // v1 and v2 on the fixture.
        val security = run(SearchRequest(query = "security talks"))
        assertEquals(listOf("track" to "🔐 Security"), security.suggestions.map { it.kind to it.value })
        assertEquals("Security", security.suggestions.single().label)
        val applied = run(SearchRequest(query = "security talks", tracks = setOf("🔐 Security")))
        assertTrue(applied.suggestions.none { it.value == "🔐 Security" }, "a selected value is not suggested again")

        assertEquals(listOf("speaker" to "Ada Example"), run(SearchRequest(query = "Ada Example")).suggestions.map { it.kind to it.value })
        assertEquals(listOf("room" to "Hall B"), run(SearchRequest(query = "hall b")).suggestions.map { it.kind to it.value })
        assertEquals(listOf("room" to "Hall A | Room 1"), run(SearchRequest(query = "room 1")).suggestions.map { it.kind to it.value })
        assertEquals(emptyList(), run(SearchRequest(query = "ada")).suggestions, "a speaker matches only by the whole name")
        assertEquals(emptyList(), run(SearchRequest(query = "")).suggestions, "browse mode suggests nothing")

        assertEquals(listOf(A, C), ids("", SearchRequest(speakers = setOf("Ada Example"))))
        assertEquals(listOf(C), ids("", SearchRequest(rooms = setOf("Hall B"))))
        // The server matches a speaker name as a phrase, so a first name alone matches too, and words
        // out of order do not.
        assertEquals(listOf(A, C), ids("", SearchRequest(speakers = setOf("ada"))))
        assertEquals(emptyList(), ids("", SearchRequest(speakers = setOf("Example Ada"))))
    }

    @Test
    fun happeningNowKeepsTalksInProgressOrStartingWithinAnHour() = runTest {
        // n1 and n2: 09:15 UTC is 10:15 in Amsterdam, so 1001 and 1002 (10:00 to 10:30) are in progress.
        val r = run(SearchRequest(happeningNow = true))
        assertTrue(r.happeningNowAvailable, "the conference has talks today in its own time zone")
        assertEquals(listOf(A, B), r.talks.map { it.talkId })
        nowMs = IsoTime.epochMillis("2099-03-02T11:45:00Z")!! // 12:45 local: 1003 starts within the hour
        assertEquals(listOf(C), ids("", SearchRequest(happeningNow = true)))
        nowMs = IsoTime.epochMillis("2099-03-02T23:30:00Z")!! // 00:30 on 3 March in Amsterdam
        val tomorrow = run(SearchRequest())
        assertFalse(tomorrow.happeningNowAvailable, "the day is the conference's, not the phone's")
        assertEquals(emptyList(), ids("", SearchRequest(happeningNow = true)))
    }

    @Test
    fun relatedTalksComeFromTheBundle() {
        assertEquals(listOf(C, B), search.related(A).map { it.talkId })
        assertEquals(listOf(A, C), search.related(B).map { it.talkId })
        assertEquals(emptyList(), search.related(Fixtures.LUNCH))
    }

    @Test
    fun searchTermsDropStopWordsAndPunctuation() {
        assertEquals(listOf("kubernetes", "scheduler"), TalkSearch.terms("The Kubernetes, scheduler!"))
        assertEquals(listOf("c", "k8s"), TalkSearch.terms("C++ and k8s"))
        assertEquals(emptyList(), TalkSearch.terms("of the and"))
    }
}
