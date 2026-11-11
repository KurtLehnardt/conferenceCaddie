package app.conferencecaddie.shared.core

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.Embedder
import app.conferencecaddie.shared.FakeHttp
import app.conferencecaddie.shared.bundle.BundleEntry
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.fixtures.Fixtures
import app.conferencecaddie.shared.search.FakeEmbedder
import app.conferencecaddie.shared.search.SearchRequest
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory

// The query embedder's life in the core: offered but not loaded until a text search needs it,
// loaded once, retried after a failure only once the pause has passed, kept across a switch of
// backend, and released and loaded again when memory is short.
class EmbedderStateTest {
    private val backend = "https://caddie.example"
    private val bundleBase = "$backend/bundles/"
    private val root = Path(SystemTemporaryDirectory, "caddie-embedder-${Random.nextLong().toULong()}")
    private val files = BundleFiles(Path(root, "bundles"))
    private var nowMs = 4_076_125_200_000L // 2099-03-02T09:00:00Z
    private val clock = object : Clock {
        override fun now(): Instant = Instant.fromEpochMilliseconds(nowMs)
    }
    private val entry = BundleEntry.read(Fixtures.entry)!!
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val database = CaddieDatabase.open(Path(root.also { SystemFileSystem.createDirectories(Path(it, "bundles")) }, "caddie.db").toString())

    @AfterTest
    fun cleanUp() = runTest {
        scope.coroutineContext.job.cancelAndJoin()
        database.closeWhenIdle()
        files.clear()
        for (child in SystemFileSystem.list(root)) SystemFileSystem.delete(child, mustExist = false)
        SystemFileSystem.delete(root, mustExist = false)
    }

    private fun http() = FakeHttp(
        mapOf(
            "$backend/capabilities.json" to FakeHttp.json(
                200,
                Fixtures.text("capabilities/tier1-demo.json").replace("https://kurtlehnardt.github.io/conferenceCaddie/bundles/", bundleBase),
            ),
            "${bundleBase}conferences.json" to FakeHttp.bytes(200, Fixtures.bytes("bundle/conferences.json")),
            "$bundleBase${entry.path}bundle.json" to FakeHttp.bytes(200, Fixtures.files.getValue("bundle.json")),
            "$bundleBase${entry.path}vectors.i8" to FakeHttp.bytes(200, Fixtures.files.getValue("vectors.i8")),
        ),
    )

    private suspend fun CaddieCore.until(predicate: (CoreState) -> Boolean): CoreState =
        withContext(Dispatchers.Default) { withTimeout(20_000) { state.first(predicate) } }

    /** An embedder that counts its loads and its closes; the first [failures] loads fail. */
    private class Loads(private val failures: Int) {
        var attempts = 0
        var closed = 0
        suspend fun load(): Embedder {
            attempts++
            if (attempts <= failures) error("the model is missing")
            val inner = FakeEmbedder(mapOf("kubernetes" to FakeEmbedder.vec(0f, 1f)))
            return object : Embedder by inner {
                override suspend fun close() {
                    closed++
                }
            }
        }
    }

    private suspend fun core(): CaddieCore {
        database.setSetting("backend", backend)
        return CaddieCore(database, files, http(), scope, allowLocalHttp = false, clock = clock).also {
            it.start()
            it.until { s -> s.bundle is BundleState.Ready }
        }
    }

    @Test
    fun theModelLoadsOnTheFirstTextSearchAndIsRetriedOnlyAfterThePause() = runTest {
        val core = core()
        assertEquals(SemanticState.Off, core.state.value.semantic)
        val loads = Loads(failures = 1)
        core.useEmbedder(loads::load)
        core.until { it.semantic == SemanticState.Idle }
        core.search(SearchRequest())
        assertEquals(0, loads.attempts, "browsing needs no model")

        // The first text search starts the load, which fails; the search itself is answered by keywords.
        val first = core.search(SearchRequest(query = "kubernetes"))
        assertFalse(first!!.semantic)
        core.until { it.semantic == SemanticState.Unavailable }
        assertEquals(1, loads.attempts)
        assertTrue(core.search(SearchRequest(query = "kubernetes"))!!.degraded, "a failed model is reported")

        // Within the pause no search tries again.
        nowMs += CaddieCore.RETRY_FIRST_MS - 1
        core.search(SearchRequest(query = "kubernetes"))
        assertEquals(1, loads.attempts)

        // After it, the next search does, and meaning-based matching joins.
        nowMs += 2
        core.search(SearchRequest(query = "kubernetes"))
        core.until { it.semantic == SemanticState.Ready }
        assertEquals(2, loads.attempts)
        assertTrue(core.search(SearchRequest(query = "kubernetes"))!!.semantic)

        // Another backend keeps the loaded model.
        core.setBackend(BackendUrl.normalise("https://other.example") as BackendUrl.Valid)
        core.until { it.backend.base == "https://other.example" }
        assertEquals(SemanticState.Ready, core.state.value.semantic)
        assertEquals(2, loads.attempts)
    }

    @Test
    fun aReleasedModelIsClosedAndLoadedAgainWhenNeeded() = runTest {
        val core = core()
        val loads = Loads(failures = 0)
        core.useEmbedder(loads::load)
        core.useEmbedder { error("a second offer is ignored") }
        core.until { it.semantic == SemanticState.Idle }
        core.forYou()
        assertEquals(0, loads.attempts, "For you without learn text needs no model")
        core.search(SearchRequest(query = "kubernetes"))
        core.until { it.semantic == SemanticState.Ready }

        core.releaseEmbedder()
        core.until { it.semantic == SemanticState.Idle }
        assertEquals(1, loads.closed)
        core.search(SearchRequest(query = "kubernetes"))
        core.until { it.semantic == SemanticState.Ready }
        assertEquals(2, loads.attempts)
    }
}
