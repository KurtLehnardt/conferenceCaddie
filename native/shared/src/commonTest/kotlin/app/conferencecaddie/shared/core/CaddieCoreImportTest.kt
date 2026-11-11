package app.conferencecaddie.shared.core

import app.conferencecaddie.shared.CapabilitiesDiscovery
import app.conferencecaddie.shared.FakeHttp
import app.conferencecaddie.shared.bundle.BundleEntry
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.fixtures.Fixtures
import app.conferencecaddie.shared.importer.ImportConfidence
import app.conferencecaddie.shared.importer.ImportInput
import app.conferencecaddie.shared.importer.ImportOutcome
import app.conferencecaddie.shared.importer.ImportRefusal
import app.conferencecaddie.shared.net.HttpResponse
import app.conferencecaddie.shared.net.PostJson
import kotlin.concurrent.atomics.AtomicReference
import kotlin.concurrent.atomics.ExperimentalAtomicApi
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// "Import my schedule" through the core: the device's import over the installed bundle on a backend
// that says imports.schedule: device, the backend's import on one that says server (its answer
// mapped onto the bundle, its refusals passed on, and every other failure read on the device), the
// legacy backend without format hints, and the checks of the input. Also the bulk mark that an
// import and a cleared list use.
@OptIn(ExperimentalAtomicApi::class)
class CaddieCoreImportTest {
    private val backend = "https://caddie.example"
    private val bundleBase = "$backend/bundles/"
    private val root = Path(SystemTemporaryDirectory, "caddie-import-${Random.nextLong().toULong()}")
    private val dbPath = Path(root, "caddie.db").toString()
    private val files = BundleFiles(Path(root, "bundles"))
    private val scopes = ArrayList<CoroutineScope>()
    private val databases = ArrayList<CaddieDatabase>()
    private val clock = object : Clock {
        override fun now(): Instant = Instant.fromEpochMilliseconds(4_076_125_200_000L) // 2099-03-02T09:00:00Z
    }
    private val entry = BundleEntry.read(Fixtures.entry)!!

    private val twoTitles = "Securing MCP servers in production\nEnergy-aware Kubernetes scheduling\n"

    init {
        SystemFileSystem.createDirectories(Path(root, "bundles"))
    }

    @AfterTest
    fun cleanUp() = runTest {
        stopAll()
        files.clear()
        for (child in SystemFileSystem.list(root)) SystemFileSystem.delete(child, mustExist = false)
        SystemFileSystem.delete(root, mustExist = false)
    }

    private suspend fun stopAll() {
        scopes.forEach { it.coroutineContext.job.cancelAndJoin() }
        scopes.clear()
        databases.forEach { it.closeWhenIdle() }
        databases.clear()
    }

    /** A stand-in for the backend's import route: every request is recorded and answered by [answer]. */
    private class FakePost(var answer: (String) -> Any) : PostJson {
        private val log = AtomicReference(emptyList<Pair<String, String>>())
        val calls: List<Pair<String, String>> get() = log.load()

        override suspend fun post(url: String, body: ByteArray, timeoutMs: Long, maxBytes: Long): HttpResponse {
            while (true) {
                val before = log.load()
                if (log.compareAndSet(before, before + (url to body.decodeToString()))) break
            }
            return when (val a = answer(body.decodeToString())) {
                is HttpResponse -> a
                is Throwable -> throw a
                else -> error("bad answer")
            }
        }
    }

    private fun capabilities(schedule: String, base: String = bundleBase) = Fixtures.text("capabilities/tier1-demo.json")
        .replace("https://kurtlehnardt.github.io/conferenceCaddie/bundles/", base)
        .replace("\"schedule\": \"device\"", "\"schedule\": \"$schedule\"")

    private fun bundleRoutes(base: String = bundleBase): Map<String, Any> = mapOf(
        "${base}conferences.json" to FakeHttp.bytes(200, Fixtures.bytes("bundle/conferences.json")),
        "$base${entry.path}bundle.json" to FakeHttp.bytes(200, Fixtures.files.getValue("bundle.json")),
        "$base${entry.path}vectors.i8" to FakeHttp.bytes(200, Fixtures.files.getValue("vectors.i8")),
    )

    /** Tier 1's document at /capabilities.json with imports.schedule [schedule]. */
    private fun http(schedule: String = "device"): FakeHttp =
        FakeHttp(bundleRoutes() + ("$backend/capabilities.json" to FakeHttp.json(200, capabilities(schedule))))

    private suspend fun launch(http: FakeHttp, post: PostJson, chooseBackend: Boolean = true): CaddieCore {
        val database = CaddieDatabase.open(dbPath).also { databases += it }
        if (chooseBackend) database.setSetting("backend", backend)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        return CaddieCore(database, files, http, scope, allowLocalHttp = false, clock = clock, postJson = post).also { it.start() }
    }

    private suspend fun CaddieCore.until(timeoutMs: Long = 20_000, predicate: (CoreState) -> Boolean): CoreState =
        withContext(Dispatchers.Default) { withTimeout(timeoutMs) { state.first(predicate) } }

    private suspend fun CaddieCore.ready(): CoreState =
        until { it.bundle is BundleState.Ready && (it.capabilities as? CapabilitiesState.Ready)?.checking == false }

    private fun ImportOutcome.done(): ImportOutcome.Done = assertIs<ImportOutcome.Done>(this)

    private fun ImportOutcome.Done.ids() = result.matched.map { it.talk.talkId }

    private fun serverAnswer(status: Int, body: String) = HttpResponse(status, body.encodeToByteArray())

    // ---------------------------------------------------------------------------------------------

    @Test
    fun aTier1BackendImportsOnTheDevice() = runTest {
        val post = FakePost { error("the device backend is never asked") }
        val core = launch(http(), post)
        core.ready()
        val done = core.importSchedule(ImportInput.Text(twoTitles)).done()
        assertEquals(false, done.onServer)
        assertEquals(listOf(Fixtures.A, Fixtures.C), done.ids())
        assertEquals(listOf(ImportConfidence.ExactTitle, ImportConfidence.ExactTitle), done.result.matched.map { it.confidence })
        assertEquals(0, done.result.unmatchedCount)
        assertEquals(twoTitles.length, done.result.extractedChars)
        assertTrue(post.calls.isEmpty())
        // A file reads the same, and nothing is marked by an import.
        val file = core.importSchedule(ImportInput.File(twoTitles.encodeToByteArray(), "picks.txt", "text/plain")).done()
        assertEquals(listOf(Fixtures.A, Fixtures.C), file.ids())
        assertEquals(emptyList(), core.state.value.interested)
    }

    @Test
    fun aServerBackendImportsThroughItsRouteAndItsAnswerIsMappedOntoTheBundle() = runTest {
        val answer = """{"matched":[
            {"talk":{"talk_id":"${Fixtures.C}","title":"x"},"confidence":"title_and_speaker","matched_text_excerpt":"Energy-aware Kubernetes scheduling"},
            {"talk":{"talk_id":"${Fixtures.SLUG}:9999"},"confidence":"exact_title","matched_text_excerpt":"A talk this device has not got"},
            {"talk":{"talk_id":"${Fixtures.A}"},"confidence":"something_new","matched_text_excerpt":"Securing MCP servers in production"},
            {"talk":{"talk_id":"${Fixtures.C}"},"confidence":"exact_title","matched_text_excerpt":"twice"}
        ],"unmatched_count":2,"extracted_chars":71}"""
        val post = FakePost { serverAnswer(200, answer) }
        val core = launch(http("server"), post)
        core.ready()
        val done = core.importSchedule(ImportInput.File("Title,Speaker\nEnergy-aware Kubernetes scheduling,Ada\n".encodeToByteArray(), "my.csv", "text/csv")).done()
        assertEquals(true, done.onServer)
        assertEquals(listOf(Fixtures.C, Fixtures.A), done.ids(), "a talk the bundle lacks is left out, and a talk listed twice once")
        assertEquals(listOf(ImportConfidence.TitleAndSpeaker, ImportConfidence.TitleWords), done.result.matched.map { it.confidence }, "an unknown label is the weakest")
        assertEquals(3, done.result.unmatchedCount, "the talk left out counts as unmatched")
        assertEquals(71, done.result.extractedChars)

        val (url, body) = post.calls.single()
        assertEquals("$backend/api/import/schedule", url)
        val sent = Json.parseToJsonElement(body).jsonObject
        assertEquals(setOf("event", "text", "filename", "mime"), sent.keys)
        assertEquals(Fixtures.SLUG, sent["event"]!!.jsonPrimitive.content)
        assertEquals("Title,Speaker\nEnergy-aware Kubernetes scheduling,Ada\n", sent["text"]!!.jsonPrimitive.content)
        assertEquals("my.csv", sent["filename"]!!.jsonPrimitive.content)
        assertEquals("text/csv", sent["mime"]!!.jsonPrimitive.content)

        // Pasted text goes alone, without hints.
        core.importSchedule(ImportInput.Text(twoTitles)).done()
        assertEquals(setOf("event", "text"), Json.parseToJsonElement(post.calls.last().second).jsonObject.keys)
    }

    @Test
    fun hintsAreCutToTheRoutesLimits() = runTest {
        val post = FakePost { serverAnswer(200, """{"matched":[],"unmatched_count":0,"extracted_chars":1}""") }
        val core = launch(http("server"), post)
        core.ready()
        core.importSchedule(ImportInput.File(twoTitles.encodeToByteArray(), "a".repeat(300) + ".txt", "text/" + "x".repeat(200))).done()
        val sent = Json.parseToJsonElement(post.calls.single().second) as JsonObject
        assertEquals(255, sent["filename"]!!.jsonPrimitive.content.length)
        assertEquals(127, sent["mime"]!!.jsonPrimitive.content.length)
    }

    @Test
    fun theServersOwnRefusalIsPassedOn() = runTest {
        val message = "That file is larger than 5 MB. Export a shorter schedule, or paste its text instead."
        val post = FakePost { serverAnswer(413, """{"error":"$message"}""") }
        val core = launch(http("server"), post)
        core.ready()
        assertEquals(ImportOutcome.Refused(ImportRefusal.Server, message), core.importSchedule(ImportInput.Text(twoTitles)))
        // A refusal without a usable sentence is the device's own.
        post.answer = { serverAnswer(422, "<html>no</html>") }
        assertEquals(ImportOutcome.Refused(ImportRefusal.PasteEmpty), core.importSchedule(ImportInput.Text(twoTitles)))
        post.answer = { serverAnswer(413, """{"error":{"nested":true}}""") }
        assertEquals(ImportOutcome.Refused(ImportRefusal.TooLarge), core.importSchedule(ImportInput.File(twoTitles.encodeToByteArray(), "a.txt", "")))
    }

    @Test
    fun anyOtherFailureOfTheServerIsReadOnTheDevice() = runTest {
        val post = FakePost { serverAnswer(503, """{"error":"busy"}""") }
        val core = launch(http("server"), post)
        core.ready()
        val answers = listOf<(String) -> Any>(
            { serverAnswer(503, """{"error":"busy"}""") },
            { serverAnswer(429, """{"error":"Too many imports in a short time. Wait a minute and try again."}""") },
            { serverAnswer(400, """{"error":"Unknown key: filename"}""") },
            { serverAnswer(200, "not json") },
            { serverAnswer(200, """{"matched":[{"talk":{}}]}""") },
            { IllegalStateException("offline") },
        )
        for ((i, a) in answers.withIndex()) {
            post.answer = a
            val done = core.importSchedule(ImportInput.Text(twoTitles)).done()
            assertEquals(false, done.onServer, "answer $i")
            assertEquals(listOf(Fixtures.A, Fixtures.C), done.ids(), "answer $i")
        }
        assertEquals(answers.size, post.calls.size)
    }

    @Test
    fun aFileLongerThanTheRoutesTextLimitIsReadOnTheDevice() = runTest {
        val post = FakePost { error("not asked") }
        val core = launch(http("server"), post)
        core.ready()
        val long = twoTitles + "\n" + "Filler line of notes\n".repeat(10_000)
        val done = core.importSchedule(ImportInput.File(long.encodeToByteArray(), "notes.txt", "")).done()
        assertEquals(false, done.onServer)
        assertTrue(Fixtures.A in done.ids())
        assertTrue(post.calls.isEmpty())
    }

    @Test
    fun aLegacyBackendGetsNoFormatHints() = runTest {
        val base = Defaults.FALLBACK_BUNDLE_BASE
        val http = FakeHttp(
            bundleRoutes(base) + mapOf(
                "$backend/api/capabilities" to FakeHttp.json(404, """{"error":"Not found"}"""),
                "$backend/api/health" to FakeHttp.json(200, """{"ok":true}"""),
            ),
        )
        val post = FakePost { serverAnswer(200, """{"matched":[{"talk":{"talk_id":"${Fixtures.A}"},"confidence":"exact_title","matched_text_excerpt":"Securing MCP servers in production"}],"unmatched_count":0,"extracted_chars":36}""") }
        val core = launch(http, post)
        val s = core.ready()
        assertEquals(CapabilitiesDiscovery.Source.Legacy, assertIs<CapabilitiesState.Ready>(s.capabilities).source)
        val done = core.importSchedule(ImportInput.File(twoTitles.encodeToByteArray(), "picks.csv", "text/csv")).done()
        assertEquals(true, done.onServer)
        assertEquals(listOf(Fixtures.A), done.ids())
        assertEquals(setOf("event", "text"), Json.parseToJsonElement(post.calls.single().second).jsonObject.keys)
    }

    @Test
    fun whileTheBackendCannotBeReachedTheDeviceReadsTheScheduleWithoutAsking() = runTest {
        val post = FakePost { serverAnswer(200, """{"matched":[],"unmatched_count":0,"extracted_chars":1}""") }
        launch(http("server"), post).ready()
        stopAll()
        val down = FakeHttp(listOf("$backend/api/capabilities", "$backend/capabilities.json", "${bundleBase}conferences.json").associateWith { IllegalStateException("offline") })
        val offlinePost = FakePost { error("not asked while offline") }
        val core = launch(down, offlinePost, chooseBackend = false)
        val s = core.until { it.bundle is BundleState.Ready && (it.capabilities as? CapabilitiesState.Ready)?.let { c -> c.cached && !c.checking } == true }
        assertIs<BundleState.Ready>(s.bundle)
        val done = core.importSchedule(ImportInput.Text(twoTitles)).done()
        assertEquals(false, done.onServer)
        assertEquals(listOf(Fixtures.A, Fixtures.C), done.ids())
        assertTrue(offlinePost.calls.isEmpty())
    }

    @Test
    fun inputsAreCheckedAsTheBackendsCheckThem() = runTest {
        val post = FakePost { error("never asked: every input here is refused first") }
        val core = launch(http("server"), post)
        core.ready()
        suspend fun refusal(input: ImportInput) = assertIs<ImportOutcome.Refused>(core.importSchedule(input)).reason
        val pdf = "%PDF-1.4\n1 0 obj\n".encodeToByteArray()
        assertEquals(ImportRefusal.Document, refusal(ImportInput.File(pdf, "schedule", "")))
        assertEquals(ImportRefusal.Document, refusal(ImportInput.File(twoTitles.encodeToByteArray(), "schedule.PDF", "")))
        assertEquals(ImportRefusal.Document, refusal(ImportInput.File(twoTitles.encodeToByteArray(), "s", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")))
        assertEquals(ImportRefusal.Document, refusal(ImportInput.File(byteArrayOf(0x50, 0x4B, 0x03, 0x04, 1, 2), "s.bin", "")))
        assertEquals(ImportRefusal.Document, refusal(ImportInput.File("{\\rtf1 hello}".encodeToByteArray(), "s.txt", "")))
        assertEquals(ImportRefusal.TooLarge, refusal(ImportInput.File(ByteArray(5 * 1024 * 1024 + 1) { 'a'.code.toByte() }, "big.txt", "")))
        assertEquals(ImportRefusal.Empty, refusal(ImportInput.File(ByteArray(0), "empty.txt", "")))
        assertEquals(ImportRefusal.Unsupported, refusal(ImportInput.File(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0xFF.toByte(), 0xFE.toByte(), 0, 0x80.toByte()), "x.png", "image/png")))
        assertEquals(ImportRefusal.Unreadable, refusal(ImportInput.File("﻿﻿  \n\t".encodeToByteArray(), "blank.txt", "")))
        assertEquals(ImportRefusal.PasteEmpty, refusal(ImportInput.Text(" \n ")))
        assertEquals(ImportRefusal.PasteTooLong, refusal(ImportInput.Text("a".repeat(200_001))))
        // A mime that only starts like a document's is not one.
        assertIs<ImportOutcome.Done>(core.importSchedule(ImportInput.File(twoTitles.encodeToByteArray(), "s.txt", "application/pdfx")))
        assertTrue(post.calls.size == 1)
    }

    @Test
    fun noReadyBundleIsUnavailable() = runTest {
        val core = launch(FakeHttp(), FakePost { error("not asked") })
        assertEquals(ImportOutcome.Refused(ImportRefusal.Unavailable), core.importSchedule(ImportInput.Text(twoTitles)))
    }

    @Test
    fun aBulkMarkPublishesTheWholeListOnceAndKeepsCopies() = runTest {
        val core = launch(http(), FakePost { error("not asked") })
        val ready = core.ready()
        val talks = assertIs<BundleState.Ready>(ready.bundle).bundle.talks.filter { it.isTalk }
        val seen = AtomicReference(emptyList<List<String>>())
        val watcher = CoroutineScope(Dispatchers.Unconfined).launch {
            core.state.collect { s ->
                while (true) {
                    val before = seen.load()
                    if (seen.compareAndSet(before, before + listOf(s.interested))) break
                }
            }
        }
        core.setInterested(talks, true)
        val marked = core.until { it.interested.size == talks.size }
        assertEquals(talks.map { it.title }.toSet(), marked.interestedSnapshots.values.map { it.title }.toSet())
        core.setInterested(talks, false)
        core.until { it.interested.isEmpty() }
        core.awaitIdle()
        watcher.cancelAndJoin()
        val sizes = seen.load().map { it.size }.distinct()
        assertTrue(sizes.all { it == 0 || it == talks.size }, "never part of the list: $sizes")
        assertNull(core.state.value.interestedSnapshots[Fixtures.A])
    }

    @Test
    fun aBulkMarkKeepsTheOrderItWasGiven() = runTest {
        // The clock stands still, so only the order given can tell the marks apart.
        val core = launch(http(), FakePost { error("not asked") })
        val ready = core.ready()
        val talks = assertIs<BundleState.Ready>(ready.bundle).bundle.talks.filter { it.isTalk }
        assertTrue(talks.size >= 3)
        // Not in talk id order, so an order by id would show.
        val given = talks.sortedByDescending { it.talkId }
        core.setInterested(given, true)
        assertEquals(given.map { it.talkId }, core.until { it.interested.size == given.size }.interested)
        // Clear list, then Undo in the order the talks had been marked: the list comes back the same.
        core.setInterested(given, false)
        core.until { it.interested.isEmpty() }
        core.setInterested(given, true)
        assertEquals(given.map { it.talkId }, core.until { it.interested.size == given.size }.interested)
    }
}
