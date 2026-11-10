package app.conferencecaddie.shared.search

import app.conferencecaddie.shared.Embedder
import app.conferencecaddie.shared.bundle.IsoTime
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.embed.BgeEmbedder
import app.conferencecaddie.shared.fixtures.Fixtures
import app.conferencecaddie.shared.fixtures.Fixtures.A
import app.conferencecaddie.shared.fixtures.Fixtures.B
import app.conferencecaddie.shared.fixtures.Fixtures.C
import kotlin.math.abs
import kotlin.math.sqrt
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Instant
import kotlinx.coroutines.test.runTest

/**
 * An embedder that answers fixed vectors by query, so ranking can be checked by hand. It sees the
 * query with the model's retrieval instruction in front, as the real one does.
 */
class FakeEmbedder(private val vectors: Map<String, FloatArray>) : Embedder {
    val seen = ArrayList<String>()
    override val modelId = BgeEmbedder.MODEL_ID
    override val dimensions = 384

    override suspend fun embed(texts: List<String>): List<FloatArray> = texts.map { input ->
        seen += input
        check(input.startsWith(BgeEmbedder.QUERY_INSTRUCTION)) { "a query must carry the retrieval instruction" }
        vectors[input.removePrefix(BgeEmbedder.QUERY_INSTRUCTION)] ?: FloatArray(384)
    }

    companion object {
        /** A 384-dimension vector with the given leading components. */
        fun vec(vararg head: Float) = FloatArray(384).also { head.copyInto(it) }
    }
}

// Hybrid search over the fixture bundle, whose talk vectors are unit vectors chosen by hand
// (docs/contracts/talk-bundle.md, Fixture): 1001 = e0, 1002 = e1, 1003 = 0.6 e0 - 0.8 e1, quantised
// to int8. With a query vector, the nearest talks are fused with the keyword matches by reciprocal
// rank fusion (k = 60), as the server's rrf retriever fuses its two lists.
class HybridSearchTest {
    private val database = CaddieDatabase.open(":memory:")
    private val scope = "https://caddie.example\n${Fixtures.SLUG}"
    private val bundle = TalkBundle.decode(Fixtures.HASH, Fixtures.files.getValue("bundle.json"), Fixtures.files.getValue("vectors.i8"))!!
    private val embedder = FakeEmbedder(
        mapOf(
            "secure tool calls" to FakeEmbedder.vec(1f),
            "beginner courses" to FakeEmbedder.vec(0f, 1f),
            "kubernetes" to FakeEmbedder.vec(0f, 1f),
            "frugal electricity" to FakeEmbedder.vec(0.6f, -0.8f),
        ),
    )
    private var failed = false
    private var loaded: Embedder? = embedder
    private val nowMs = IsoTime.epochMillis("2099-03-02T08:00:00Z")!!
    private val search = TalkSearch(bundle, scope, database, now = { Instant.fromEpochMilliseconds(nowMs) }, embedder = { loaded }, embedderFailed = { failed })

    @AfterTest
    fun close() = database.close()

    private suspend fun run(request: SearchRequest): SearchResult {
        if (database.installedBundle(scope) == null) database.install(scope, bundle, 0)
        return search.search(request)
    }

    @Test
    fun vectorsDecodeAndCosinesFollowTheContract() {
        val v = assertNotNull(bundle.vectors)
        assertEquals(listOf(A, B, C), v.rows)
        val a = v.rowOf(A)!!
        val b = v.rowOf(B)!!
        val c = v.rowOf(C)!!
        assertNull(v.rowOf(Fixtures.LUNCH), "a break has no row")
        assertEquals(0.0, v.cosine(a, b))
        assertTrue(abs(v.cosine(a, c) - 95.0 / sqrt(95.0 * 95 + 127.0 * 127)) < 1e-12)
        assertTrue(abs(v.cosine(b, c) + 127.0 / sqrt(95.0 * 95 + 127.0 * 127)) < 1e-12)
        assertTrue(abs(v.cosine(FakeEmbedder.vec(2f), a) - 1.0) < 1e-12, "a float query needs no quantisation")
        assertEquals(0.0, v.cosine(FloatArray(384), a), "a zero vector has similarity 0")
        val centre = assertNotNull(v.centroid(listOf(a, b)))
        assertTrue(abs(centre[0] - 0.5f) < 1e-6 && abs(centre[1] - 0.5f) < 1e-6)
        assertNull(v.centroid(emptyList()))
        assertNull(TalkBundle.decode(Fixtures.HASH, Fixtures.files.getValue("bundle.json"), ByteArray(10)), "a vector file of the wrong length is refused")
    }

    @Test
    fun aMeaningOnlyQueryFindsTalksWithoutSharedWords() = runTest {
        // No keyword matches; the nearest talks by meaning, with no threshold (like knn), are the
        // matches, best first.
        val r = run(SearchRequest(query = "frugal electricity"))
        assertTrue(r.semantic)
        assertFalse(r.degraded)
        assertEquals(listOf(C, A, B), r.talks.map { it.talkId })
        assertEquals(Ranking(1, null, 1), r.ranking[C])
        assertEquals(Ranking(3, null, 3), r.ranking[B])
        assertEquals(BgeEmbedder.QUERY_INSTRUCTION + "frugal electricity", embedder.seen.single())
    }

    @Test
    fun keywordAndMeaningListsAreFusedByReciprocalRank() = runTest {
        // Keywords: "kubernetes" matches 1002 (title, shorter) then 1003. Meaning (e1): 1002, 1001,
        // then 1003 (negative). 1002 is first in both; 1003 is second by keywords and third by
        // meaning (1/62 + 1/63) and so beats 1001, second by meaning only (1/62).
        val r = run(SearchRequest(query = "kubernetes"))
        assertEquals(listOf(B, C, A), r.talks.map { it.talkId })
        assertEquals(Ranking(1, 1, 1), r.ranking[B])
        assertEquals(Ranking(2, 2, 3), r.ranking[C])
        assertEquals(Ranking(3, null, 2), r.ranking[A])
        assertEquals(3, r.total, "the matches are the keyword matches plus the nearest talks")
        // The fused score never rises down the list (scripts/smoke.mjs, k1).
        val scores = r.talks.map { t -> r.ranking.getValue(t.talkId).let { g -> listOfNotNull(g.keywordRank, g.semanticRank).sumOf { 1.0 / (60 + it) } } }
        assertEquals(scores.sortedDescending(), scores)
    }

    @Test
    fun selectionsApplyAfterTheNearestTalksAreChosenAndRanksCountWhatIsShown() = runTest {
        val r = run(SearchRequest(query = "secure tool calls", tracks = setOf("Kubernetes")))
        // The nearest of all talks are 1001, 1003, 1002; the track keeps 1003 and 1002, whose ranks
        // in the meaning list are then 1 and 2, as the server's rrf filter passes down to each list.
        assertEquals(listOf(C, B), r.talks.map { it.talkId })
        assertEquals(Ranking(1, null, 1), r.ranking[C])
        assertEquals(listOf(FacetCount("Kubernetes", 2), FacetCount("🔐 Security", 1)), r.facets.track, "facets count the nearest talks too")
        // Base filters apply before: an afternoon search leaves only 1003 to be near.
        val afternoon = run(SearchRequest(query = "secure tool calls", startAfter = 12 * 60))
        assertEquals(listOf(C), afternoon.talks.map { it.talkId })
    }

    @Test
    fun browseModeHasNoRanking() = runTest {
        val r = run(SearchRequest())
        assertEquals(listOf(A, B, C), r.talks.map { it.talkId })
        assertTrue(r.ranking.isEmpty())
        assertFalse(r.semantic)
        assertTrue(embedder.seen.isEmpty(), "browse mode embeds nothing")
    }

    @Test
    fun withoutTheModelSearchIsKeywordsAloneAndSaysSoOnceItFailed() = runTest {
        loaded = null
        val loading = run(SearchRequest(query = "kubernetes"))
        assertFalse(loading.semantic)
        assertFalse(loading.degraded, "a model still loading is not a failure")
        assertEquals(listOf(B, C), loading.talks.map { it.talkId })
        assertEquals(Ranking(1, 1, null), loading.ranking[B])
        failed = true
        assertTrue(run(SearchRequest(query = "kubernetes")).degraded)
        assertFalse(run(SearchRequest()).degraded, "browse mode is never degraded")
    }

    @Test
    fun topicsTrackAndRoomStandInForMeaningOnlyWithoutTheModel() = runTest {
        // "hall" is only in the room column. With meaning-based matching the keyword list reads the
        // server's columns (title, abstract, speakers, taglines), so it matches by keywords nowhere.
        val withModel = run(SearchRequest(query = "hall"))
        assertTrue(withModel.talks.all { withModel.ranking.getValue(it.talkId).keywordRank == null })
        loaded = null
        assertEquals(setOf(A, B, C), run(SearchRequest(query = "hall")).talks.map { it.talkId }.toSet())
    }

    @Test
    fun aFailedEmbeddingFallsBackToKeywords() = runTest {
        loaded = object : Embedder {
            override val modelId = BgeEmbedder.MODEL_ID
            override val dimensions = 384
            override suspend fun embed(texts: List<String>): List<FloatArray> = error("ONNX Runtime failed")
        }
        val r = run(SearchRequest(query = "kubernetes"))
        assertFalse(r.semantic)
        assertEquals(listOf(B, C), r.talks.map { it.talkId })
    }

    @Test
    fun anEmbedderOfAnotherModelIsNeverCompared() = runTest {
        loaded = object : Embedder {
            override val modelId = "another/model"
            override val dimensions = 384
            override suspend fun embed(texts: List<String>): List<FloatArray> = texts.map { FakeEmbedder.vec(1f) }
        }
        assertFalse(run(SearchRequest(query = "kubernetes")).semantic)
    }

    @Test
    fun aBundleWithoutVectorsSearchesByKeywords() = runTest {
        val plain = TalkBundle.decode(Fixtures.HASH, Fixtures.files.getValue("bundle.json"))!!
        database.install(scope, plain, 0)
        val r = TalkSearch(plain, scope, database, embedder = { embedder }).search(SearchRequest(query = "kubernetes"))
        assertFalse(r.semantic)
        assertEquals(listOf(B, C), r.talks.map { it.talkId })
    }
}
