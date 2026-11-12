package app.conferencecaddie.ui.people

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.GeoFix
import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.net.ApiHttp
import app.conferencecaddie.shared.people.PeopleAvailability
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.Profile
import app.conferencecaddie.shared.people.SyncStatus
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.talks.CaddieApp
import app.conferencecaddie.ui.talks.TestBackend
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.datetime.TimeZone
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean

// The whole People journey through the app as a person meets it: CaddieApp over a real CaddieCore on
// TestBackend (people features on), with a PeopleController on the fake People server. Settings,
// Profile, the People search, presence, an ask that is accepted, Meet up with the distance, We found
// each other, a block from the card, Blocked people in Settings, and Delete my profile. What the
// server received is checked as the journey goes. Runs on the iOS simulator and on Android.
@OptIn(ExperimentalTestApi::class, ExperimentalCoroutinesApi::class)
class PeopleFlowUiTest {
    private val slug = "alpha-conf-2099"
    private val clock = TestClock()
    private val server = FakePeopleServer({ clock.ms }, FakeConference.alpha())
    private val location = FakeDeviceLocation(LocationAccess.Precise)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // The controller works on another thread: every request, and every read or action of the test
    // on the fake server, runs under one lock.
    private val mutex = Mutex()

    /** Every request the controller sent, oldest first; safe to read from the test's thread. */
    private val calls = MutableStateFlow<List<RecordedRequest>>(emptyList())
    private val http = ApiHttp { method, url, headers, body, timeoutMs, maxBytes ->
        mutex.withLock {
            calls.update { it + RecordedRequest(method, url, headers, body?.decodeToString()) }
            server.send(method, url, headers, body, timeoutMs, maxBytes)
        }
    }
    private val keyValue = InMemoryPeopleKeyValue()
    private val controller = PeopleController(
        keyValue,
        http,
        PeopleServices(InMemorySecureStore(), location = location),
        scope,
        allowLocalHttp = false,
        clock = clock,
        timeZone = TimeZone.UTC,
    )

    @AfterTest
    fun cleanUp() {
        controller.close()
        scope.cancel()
    }

    @Test
    fun findSomeoneMeetThemBlockThemAndDeleteMyProfile() = runComposeUiTest {
        val backend = TestBackend(people = true)
        val root = Path(SystemTemporaryDirectory, "caddie-flow-${Random.nextLong().toULong()}")
        SystemFileSystem.createDirectories(Path(root, "bundles"))
        val files = BundleFiles(Path(root, "bundles"))
        val database = CaddieDatabase.open(":memory:")
        val coreScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val core = CaddieCore(database, files, backend, coreScope, allowLocalHttp = false)
            core.setBackend(testBackendUrl(backend.base))
            controller.bind(core.state)
            await { controller.state.first { it.availability == PeopleAvailability.Ready && it.zones.contains("Hall A") } }
            // Kim has run Kubernetes upgrades; she is visible and around in Hall B, with her position.
            val kim = await {
                locked {
                    seedPerson(slug, "Kim Seed", about = "SRE.", expertise = "Ran Kubernetes upgrades for 40 clusters.", speakTopics = listOf("kubernetes"), around = "Hall B", located = true)
                }
            }
            setContent { TestPhone { CaddieApp(core, isDebugBuild = false, appVersion = "test", people = controller) } }

            // Settings, then Profile: a name, about, expertise, and visible at the conference.
            waitFor(hasContentDescription(Strings.AppBar.SETTINGS) and hasClickAction())
            onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
            waitFor(hasText(Strings.Settings.PROFILE) and hasClickAction())
            onNode(hasText(Strings.Settings.PROFILE) and hasClickAction()).performClick()
            waitFor(hasTestTag("profile-screen"))
            onNodeWithTag("profile-name").performScrollTo().typeText("Jordan Rivera")
            onNodeWithTag("profile-about-me").performScrollTo().typeText("Platform engineer.")
            onNodeWithTag("profile-expertise").performScrollTo().typeText("Built eBPF tracing for a fleet.")
            onNodeWithText(ProfileStrings.visibleAt("Alpha Conference")).performScrollTo().performClick()
            waitUntil(timeoutMillis = 20_000) { controller.state.value.visibility.openToMeet && controller.state.value.sync.state != SyncStatus.State.Saving }
            assertTrue(await { locked { me(slug) != null } }, "the profile is on the server")
            val sent = calls("PUT", "/api/people/profile").last().body!!
            assertTrue(sent.getValue("open_to_meet").let { (it as JsonPrimitive).boolean })
            val profile = sent.getValue("profile") as JsonObject
            assertEquals("Jordan Rivera", profile.text("display_name"))
            assertEquals("Platform engineer.", profile.text("about"))
            assertEquals("Built eBPF tracing for a fleet.", profile.text("expertise"))

            // The People tab: the search finds Kim, with the matched words highlighted.
            // Profile's Back leads to Settings, and Settings' Back to the tabs.
            onNodeWithContentDescription(Strings.AppBar.BACK_TO_SETTINGS).performClick()
            waitFor(hasTestTag("settings-screen"))
            onNodeWithContentDescription(Strings.AppBar.BACK).performClick()
            waitFor(hasTestTag("tab-People"))
            onNodeWithTag("tab-People").performClick()
            waitFor(hasTestTag("people-search-field"))
            onNodeWithTag("people-search-field").typeText("kubernetes upgrades")
            // Kim is listed before the search too (People to meet); the search's card marks the words.
            waitFor(hasText(PeopleStrings.PEOPLE_WHO_MATCH))
            waitFor(highlights("Kubernetes") and hasAnyAncestor(hasTestTag("person-${kim.ref}")))
            onNode(highlights("Kubernetes") and hasAnyAncestor(hasTestTag("person-${kim.ref}"))).assertIsDisplayed()
            assertTrue(calls("POST", "/api/people/matches").any { it.body?.text("query") == "kubernetes upgrades" })

            // Presence on in the Hallway: the tab becomes Who's around, Kim elsewhere at the venue.
            onNode(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL)).performScrollTo().performClick()
            waitFor(hasTestTag("presence-setup"))
            onNodeWithContentDescription(ConnectStrings.ZONE).performScrollTo().performClick()
            waitFor(hasText("Hallway"))
            onNodeWithText("Hallway").performScrollTo().performClick()
            waitUntil(timeoutMillis = 20_000) { onAllNodes(hasText(ConnectStrings.ZONE)).fetchSemanticsNodes().isEmpty() }
            onNodeWithContentDescription(ConnectStrings.ZONE).assertTextEquals("Hallway")
            onNodeWithText(ConnectStrings.I_AM_AROUND).performScrollTo().performClick()
            waitUntil(timeoutMillis = 20_000) { controller.state.value.presence.on }
            assertEquals("Hallway", calls("PUT", "/api/presence").last().body!!.text("zone"))
            waitFor(hasText(PeopleStrings.AROUND_TITLE))
            waitFor(hasTestTag("person-${kim.ref}"))

            // My position goes with my presence, so a meet can say how far apart we are.
            waitFor(hasTestTag("position-step"))
            onNodeWithText(ConnectStrings.USE_MY_POSITION).performScrollTo().performClick()
            waitUntil(timeoutMillis = 20_000) {
                location.emit(GeoFix(MY_LAT, MY_LON, 10.0, clock.ms))
                calls("PUT", "/api/presence").any { it.body!!["location"] != null }
            }

            // Ask to talk shop from Kim's card, with the note the sheet suggests.
            onNode(hasText(PeopleStrings.ASK_TO_TALK_SHOP) and hasAnyAncestor(hasTestTag("person-${kim.ref}"))).performScrollTo().performClick()
            waitFor(hasTestTag("ask-send"))
            onNodeWithTag("ask-send").performClick()
            // The sheet says it was sent, as the web's does; Done closes it.
            waitFor(hasText(ConnectStrings.ASKED))
            onNodeWithText(ConnectStrings.DONE).performClick()
            waitGone(hasTestTag("ask-sheet"))
            waitFor(hasText(PeopleCommonStrings.NO_REPLY_YET) and hasAnyAncestor(hasTestTag("person-${kim.ref}")))
            val ask = calls("POST", "/api/meet").single().body!!
            assertEquals(kim.ref, ask.text("ref"))
            assertTrue(ask.text("note").orEmpty().isNotBlank())

            // Kim accepts. Requests shows the meet-up as open; Meet up shows it with the distance.
            val meetId = await { locked { kim.incoming().single().also { kim.accept(it) } } }
            onNodeWithTag("requests-button").performClick()
            waitFor(hasTestTag("inbox-screen"))
            waitFor(hasTestTag("outgoing-$meetId"))
            onNode(hasText(PeopleCommonStrings.OPEN_MEET_UP) and hasAnyAncestor(hasTestTag("outgoing-$meetId"))).performClick()
            waitFor(hasTestTag("meet-them"))
            onNode(hasText("Kim Seed") and hasAnyAncestor(hasTestTag("meet-them"))).assertIsDisplayed()
            waitFor(hasTestTag("meet-distance"))
            onNodeWithText(ConnectStrings.distance(100)).performScrollTo().assertIsDisplayed()

            // We found each other, then back to People.
            onNodeWithTag("meet-found").performScrollTo().performClick()
            waitFor(hasTestTag("meet-found-card"))
            assertEquals("found", await { locked { meetState(meetId) } })
            onNodeWithText(ConnectStrings.BACK_TO_PEOPLE).performScrollTo().performClick()
            waitFor(hasTestTag("people-home"))

            // Block Kim from her card, after the confirmation: she leaves the list.
            waitFor(hasTestTag("person-${kim.ref}"))
            onNodeWithContentDescription(PeopleCommonStrings.optionsFor("Kim Seed")).performScrollTo().performClick()
            waitFor(hasTestTag("overflow-menu"))
            onNode(hasText(PeopleCommonStrings.BLOCK) and hasAnyAncestor(hasTestTag("overflow-menu"))).performClick()
            waitFor(hasTestTag("block-confirm"))
            onNodeWithText(PeopleCommonStrings.blockTitle("Kim Seed")).assertIsDisplayed()
            onNode(hasText(PeopleCommonStrings.BLOCK) and hasClickAction() and hasAnyAncestor(hasTestTag("block-confirm"))).performClick()
            waitGone(hasTestTag("person-${kim.ref}"))
            waitUntil(timeoutMillis = 20_000) { controller.state.value.blocks.any { it.ref == kim.ref } }
            assertEquals(kim.ref, calls("POST", "/api/people/block").single().body!!.text("ref"))
            assertEquals(listOf(kim.ref), await { locked { blockedBy(me(slug)!!) } })

            // Settings lists her under Blocked people.
            onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
            waitFor(hasText("Kim Seed") and hasAnyAncestor(hasTestTag("set-blocked")))

            // Profile, Delete my profile: the server copy goes, then the device's.
            onNode(hasText(Strings.Settings.PROFILE) and hasClickAction()).performScrollTo().performClick()
            waitFor(hasTestTag("profile-screen"))
            onNodeWithTag("profile-delete").performScrollTo().performClick()
            onNodeWithTag("profile-delete-now").performScrollTo().performClick()
            waitFor(hasText(DELETED_MESSAGE))
            assertNull(await { locked { me(slug) } }, "the server copy is gone")
            assertTrue(calls("DELETE", "/api/people/profile").isNotEmpty())
            waitUntil(timeoutMillis = 20_000) { controller.state.value.profile == Profile.EMPTY }
            val after = controller.state.value
            assertFalse(after.visibility.openToMeet)
            assertFalse(after.presence.on)
            assertTrue(after.blocks.isEmpty())
            assertFalse(after.hasDevice)
            assertNull(keyValue.map.values.firstOrNull { it.contains("Jordan Rivera") }, "nothing of the profile is left on the device")

            // No request of the native app carried an Origin header.
            assertTrue(calls.value.isNotEmpty())
            assertTrue(calls.value.none { it.header("Origin") != null }, "no request carries an Origin header")
            assertFalse(await { locked { anyOrigin() } })
        } finally {
            // Every job must have stopped before the database closes, the screens' searches included:
            // closeWhenIdle waits for any statement a search still has queued.
            runBlocking { coreScope.coroutineContext.job.cancelAndJoin() }
            files.clear()
            SystemFileSystem.delete(Path(root, "bundles"), mustExist = false)
            SystemFileSystem.delete(root, mustExist = false)
            runBlocking { database.closeWhenIdle() }
        }
    }

    private suspend fun <T> locked(block: FakePeopleServer.() -> T): T = mutex.withLock { server.block() }

    /** Runs [block] on the test's scope and waits for it, rethrowing its failure. */
    private fun <T> ComposeUiTest.await(block: suspend () -> T): T {
        val job = scope.async { block() }
        waitUntil(timeoutMillis = 20_000) { job.isCompleted }
        return job.getCompleted()
    }

    private fun calls(method: String, path: String): List<RecordedRequest> = calls.value.filter { it.method == method && it.path == path }

    /** Waits for a node that [matcher] finds, printing the tree when none comes. */
    private fun ComposeUiTest.waitFor(matcher: SemanticsMatcher) {
        try {
            waitUntil(timeoutMillis = 20_000) { onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        } catch (e: Throwable) {
            throw AssertionError("Timed out waiting for ${matcher.description}\n" + onRoot(useUnmergedTree = true).printToString(), e)
        }
    }

    private fun ComposeUiTest.waitGone(matcher: SemanticsMatcher) {
        waitUntil(timeoutMillis = 20_000) { onAllNodes(matcher).fetchSemanticsNodes().isEmpty() }
    }

    private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private companion object {
        /** ProfileSync.DELETED_MESSAGE, which the controller returns once "Delete my profile" has finished. */
        const val DELETED_MESSAGE = "Your profile was deleted from this phone and from our server."

        /** A text whose `<mark>` highlight covers [word] (EvidenceText styles the marked range). */
        fun highlights(word: String) = SemanticsMatcher("highlights $word") { node ->
            node.config.getOrNull(SemanticsProperties.Text)?.any { text ->
                text.spanStyles.any { range -> text.text.substring(range.start, range.end).equals(word, ignoreCase = true) }
            } == true
        }
    }
}
