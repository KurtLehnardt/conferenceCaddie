package app.conferencecaddie.shared.search

import app.conferencecaddie.shared.Embedder
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
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

// For you over the fixture bundle (1001 MCP and Security at 10:00, 1002 Kubernetes at 10:00, 1003
// Kubernetes at 13:30; vectors e0, e1 and 0.6 e0 - 0.8 e1), following the server's
// recommendations and the r-checks of scripts/smoke.mjs.
class ForYouTest {
    private val database = CaddieDatabase.open(":memory:")
    private val scope = "https://caddie.example\n${Fixtures.SLUG}"
    private val bundle = TalkBundle.decode(Fixtures.HASH, Fixtures.files.getValue("bundle.json"), Fixtures.files.getValue("vectors.i8"))!!
    private var loaded: Embedder? = FakeEmbedder(
        mapOf(
            "protecting agent tools" to FakeEmbedder.vec(1f),
            "greener clusters" to FakeEmbedder.vec(0.6f, -0.8f),
        ),
    )
    private var failed = false
    private val search = TalkSearch(bundle, scope, database, embedder = { loaded }, embedderFailed = { failed })
    private val forYou = ForYou(bundle, search)
    private val morning = IsoTime.epochMillis("2099-03-02T08:00:00Z")!!

    @AfterTest
    fun close() = database.close()

    private suspend fun items(request: ForYou.Request, nowMs: Long = morning): ForYou.Result.Ready {
        if (database.installedBundle(scope) == null) database.install(scope, bundle, 0)
        return assertIs<ForYou.Result.Ready>(forYou.recommend(request, nowMs))
    }

    @Test
    fun nothingToGoOnNeedsInput() = runTest {
        assertEquals(ForYou.Result.NeedsInput, forYou.recommend(ForYou.Request(), morning))
        assertEquals(ForYou.Result.NeedsInput, forYou.recommend(ForYou.Request(text = "   "), morning))
    }

    @Test
    fun learnTopicsRankTalksWithMoreOfThemFirstAndNameOnlyTheRequestsTopics() = runTest {
        val r = items(ForYou.Request(learnTopics = listOf("kubernetes", "security")))
        // 1001 has security, 1002 and 1003 kubernetes: one topic each, so by start, then id.
        assertEquals(listOf(A, B, C), r.items.map { it.talk.talkId })
        assertEquals(listOf("Security"), r.items[0].learnTopics)
        assertEquals(listOf("Kubernetes"), r.items[1].learnTopics)
        assertTrue(r.items.all { it.passage == null && it.like == null })
        val two = items(ForYou.Request(learnTopics = listOf("mcp", "security", "kubernetes")))
        assertEquals(A, two.items.first().talk.talkId, "two wanted topics beat one")
        assertEquals(listOf("MCP", "Security"), two.items.first().learnTopics, "in the request's order")
    }

    @Test
    fun endedAndMarkedTalksAreLeftOut() = runTest {
        val noon = IsoTime.epochMillis("2099-03-02T11:00:00Z")!! // 12:00 in Amsterdam: the 10:00 talks have ended
        assertEquals(listOf(C), items(ForYou.Request(learnTopics = listOf("kubernetes", "security")), noon).items.map { it.talk.talkId })
        // Marking 1003 leaves it out; 1002 has the topic and 1001 is like 1003 (cosine 0.6).
        assertEquals(listOf(B, A), items(ForYou.Request(learnTopics = listOf("kubernetes"), interested = setOf(C))).items.map { it.talk.talkId })
    }

    @Test
    fun theTextFindsTalksByMeaningWithAPassage() = runTest {
        val r = items(ForYou.Request(text = "protecting agent tools"))
        assertEquals(listOf(A, C, B), r.items.map { it.talk.talkId })
        assertEquals(false, r.degraded)
        assertEquals("Threat models, tool permissions and audit logs for MCP servers.", r.items[0].passage)
        assertTrue(r.items.all { it.learnTopics.isEmpty() }, "no topic was sent, so none is named")
        // Topics and text are fused: a talk in both lists comes first.
        val both = items(ForYou.Request(learnTopics = listOf("kubernetes"), text = "greener clusters"))
        assertEquals(C, both.items.first().talk.talkId)
    }

    @Test
    fun withoutTheModelTheTextMatchesKeywordsAndSaysSoOnceItFailed() = runTest {
        loaded = null
        val loading = items(ForYou.Request(text = "audit logs"))
        assertEquals(listOf(A), loading.items.map { it.talk.talkId })
        assertEquals(false, loading.degraded, "a model still loading is not reported")
        failed = true
        val r = items(ForYou.Request(text = "audit logs"))
        assertTrue(r.degraded)
        assertEquals(listOf(A), r.items.map { it.talk.talkId })
    }

    @Test
    fun markedTalksFindTalksLikeThemEvenWithoutTheModel() = runTest {
        loaded = null
        // Marked: 1001 (e0). Nearest of the rest: 1003 (cosine 0.6), then 1002 (0).
        val r = items(ForYou.Request(interested = setOf(A)))
        assertEquals(listOf(C, B), r.items.map { it.talk.talkId })
        assertEquals(A, r.items[0].like?.talkId)
        assertEquals(false, r.degraded, "marked talks need only the bundle's vectors")
    }

    @Test
    fun theSameRequestAlwaysGivesTheSameOrder() = runTest {
        val request = ForYou.Request(learnTopics = listOf("kubernetes"), text = "greener clusters", interested = setOf(A))
        val first = items(request).items.map { it.talk.talkId }
        repeat(4) { assertEquals(first, items(request).items.map { it.talk.talkId }) }
        assertEquals(1, items(request.copy(size = 1)).items.size)
    }

    @Test
    fun eventsAndBreaksAreNeverSuggested() = runTest {
        val r = items(ForYou.Request(learnTopics = listOf("kubernetes", "mcp", "security"), text = "protecting agent tools"))
        assertTrue(r.items.all { it.talk.kind == "talk" })
        assertNull(r.items.firstOrNull { it.talk.talkId == Fixtures.LUNCH })
    }
}
