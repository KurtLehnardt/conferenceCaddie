package app.conferencecaddie.shared.importer

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.bundle.BundleSync
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.core.Defaults
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.net.HttpResponse
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.test.runTest
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory

// The Capacitor app's Interested lists (web/src/lib/storage.ts), kept once when the native app is
// installed over it: what is read from the untrusted storage, and where the marks go. On the JVM and
// the iOS simulator.
class LegacyInterestedTest {
    private val slug = "kubecon-cloudnativecon-north-america-2026"

    private fun entry(
        id: String,
        markedAt: String,
        start: String = "2026-11-11T11:00:00-07:00",
        end: String = "2026-11-11T11:30:00-07:00",
        extra: String = "",
        conference: String = slug,
        url: String = "\"https://kccncna2026.sched.com/event/$id\"",
    ) = """{"talk_id":"$slug:$id","conference":"$conference","title":"Talk $id","speakers":["Ada","Grace"],"room":"Hall A",
        "start":"$start","end":"$end","track":"Security","level":"Advanced","tags":[],"topics":[],"speaker_profiles":[],
        "slides_url":null,"url":$url,"marked_at":"$markedAt"$extra}"""

    @Test
    fun aStoredListBecomesMarksInTheOrderTheyWereMade() {
        val value = "[" + listOf(
            entry("2", "2026-11-10T10:00:00.000Z"),
            entry("1", "2026-11-09T10:00:00.000Z", start = "2026-11-11T23:30:00-07:00", end = "2026-11-12T00:15:00-07:00"),
            entry("3", "2026-11-10T10:00:00.000Z"),
        ).joinToString(",") + "]"
        val marks = LegacyInterested.read(slug, value)
        assertEquals(listOf("$slug:1", "$slug:2", "$slug:3"), marks.map { it.talkId })
        val late = assertNotNull(marks[0].copy)
        assertEquals("2026-11-11", late.day)
        assertEquals(23 * 60 + 30, late.startMinutes)
        assertEquals(24 * 60 + 15, late.endMinutes)
        assertEquals("https://kccncna2026.sched.com/event/1", late.url)
        assertEquals(listOf("Ada", "Grace"), late.speakers)
        assertNotNull(late.toTalk())
    }

    @Test
    fun whatTheWebWouldRefuseIsLeftOut() {
        val value = "[" + listOf(
            entry("1", "a", conference = "another-conference-2026"),
            entry("2", "a", url = "null"),
            """{"talk_id":"$slug:3","conference":"$slug","title":"T","speakers":[1],"start":"x","end":"y","url":"u","tags":[]}""",
            """{"talk_id":"other:4","conference":"$slug","title":"T","speakers":[],"start":"x","end":"y","url":"u","tags":[]}""",
            """{"talk_id":"$slug:5","conference":"$slug","title":"T","speakers":[],"start":"x","end":"y","url":"u"}""",
            "\"$slug:6\"", "null", "7",
            entry("8", "a"), entry("8", "b"),
        ).joinToString(",") + "]"
        assertEquals(listOf("$slug:8"), LegacyInterested.read(slug, value).map { it.talkId })
    }

    @Test
    fun aMarkKeepsNoCopyItCannotTrustAndNoLinkThatIsNotTheWebs() {
        val marks = LegacyInterested.read(
            slug,
            "[" + entry("1", "a", start = "2026-11-11T18:00:00Z", end = "2026-11-11T18:30:00Z") + "," +
                entry("2", "b", url = "\"javascript:alert(1)\"") + "]",
        )
        // A UTC time does not carry the conference's local day and minutes: the mark comes without a copy.
        assertEquals("$slug:1", marks[0].talkId)
        assertNull(marks[0].copy)
        assertNull(marks[1].copy?.url)
    }

    @Test
    fun keysValuesAndCountsAreBounded() {
        assertEquals(slug, LegacyInterested.slugOf("caddie.interested.v1.$slug"))
        for (key in listOf("caddie.interested.v1.", "caddie.interested.v1.../x", "caddie.interested.v1.Upper", "caddie.watch.v1.$slug", "caddie.interested.v1.$slug x")) {
            assertNull(LegacyInterested.slugOf(key), key)
        }
        assertTrue(LegacyInterested.read(slug, "[" + " ".repeat(LegacyInterested.MAX_VALUE_CHARS) + "]").isEmpty())
        assertTrue(LegacyInterested.read(slug, "{\"not\":\"a list\"}").isEmpty())
        assertTrue(LegacyInterested.read(slug, "not json").isEmpty())
        val many = "[" + (1..LegacyInterested.MAX_TALKS + 50).joinToString(",") { entry("$it", "a") } + "]"
        assertEquals(LegacyInterested.MAX_TALKS, LegacyInterested.read(slug, many).size)
    }

    @Test
    fun theCoreKeepsTheMarksUnderTheDefaultBackend() = runTest {
        val root = Path(SystemTemporaryDirectory, "caddie-legacy-${Random.nextLong().toULong()}")
        SystemFileSystem.createDirectories(Path(root, "bundles"))
        val database = CaddieDatabase.open(":memory:")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val core = CaddieCore(database, BundleFiles(Path(root, "bundles")), { _, _, _ -> HttpResponse(404, ByteArray(0)) }, scope, allowLocalHttp = false)
        try {
            val key = BundleSync.scope((BackendUrl.normalise(Defaults.BACKEND) as BackendUrl.Valid).base, slug)
            database.setInterested(key, "$slug:2", true, 1L, null)
            core.importLegacyInterested(
                mapOf(
                    "caddie.interested.v1.$slug" to "[" + entry("1", "a") + "," + entry("2", "b") + "]",
                    "caddie.interested.v1.Bad Key" to "[" + entry("9", "a") + "]",
                    "caddie.theme" to "dark",
                ),
            )
            core.awaitIdle()
            // The mark made in the app stays first; the old app's other mark joins it with its copy.
            assertEquals(listOf("$slug:2", "$slug:1"), database.interested(key))
            assertEquals("Talk 1", database.interestedSnapshots(key)["$slug:1"]?.title)
        } finally {
            scope.coroutineContext.job.cancelAndJoin()
            database.closeWhenIdle()
            SystemFileSystem.delete(Path(root, "bundles"), mustExist = false)
            SystemFileSystem.delete(root, mustExist = false)
        }
    }
}
