package app.conferencecaddie.ui.people

import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.core.BundleState
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.people.PeopleAvailability
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.shared.people.Profile
import app.conferencecaddie.ui.shell.ShellNavigation
import app.conferencecaddie.ui.talks.TestBackend
import app.conferencecaddie.ui.theme.CaddieTheme
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/**
 * What U1's UI tests share: the talk core on [TestBackend] (people features on) with the Alpha
 * conference's bundle, a real [app.conferencecaddie.shared.people.PeopleController] that follows
 * that core and talks to [server], the in-memory People API, and the toasts a [host] showed.
 */
internal class U1Fixture(
    /** Replaces the Alpha conference of the backend before the app first asks for it, as the one the fake People server knows too ([fakeConference]). */
    testConference: TestBackend.TestConference? = null,
    fakeConference: FakeConference = FakeConference.alpha(),
) {
    val backend = TestBackend(people = true).also { b -> testConference?.let { b.publish(listOf(it, b.beta)) } }
    private val root = Path(SystemTemporaryDirectory, "caddie-u1-${Random.nextLong().toULong()}")
    private val database = CaddieDatabase.open(":memory:")
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val files = BundleFiles(Path(root, "bundles")).also { SystemFileSystem.createDirectories(Path(root, "bundles")) }
    val core = CaddieCore(database, files, backend, scope, allowLocalHttp = false).also {
        it.setBackend(BackendUrl.normalise(backend.base) as BackendUrl.Valid)
    }
    val clock = TestClock()
    val server = FakePeopleServer({ clock.ms }, fakeConference)
    val controller = testPeopleController(server, scope, clock).also { it.bind(core.state) }
    val toasts = ArrayList<String>()
    val openedTalks = ArrayList<String>()
    val navigation = ShellNavigation()
    val host = PeopleHost(controller, navigation, scope, { message, _ -> toasts += message }, { openedTalks += it }, {})

    val slug = "alpha-conf-2099"

    /** The installed bundle of the selected conference, or null while it loads. */
    val bundle: TalkBundle? get() = (core.state.value.bundle as? BundleState.Ready)?.bundle

    /** Runs a controller action from the test thread. */
    fun <T> act(block: suspend () -> T): T = runBlocking { block() }

    fun close() {
        controller.close()
        // Every job must have stopped before the database closes, the screens' searches included:
        // closeWhenIdle waits for any statement a search still has queued.
        runBlocking { scope.coroutineContext.job.cancelAndJoin() }
        files.clear()
        SystemFileSystem.delete(Path(root, "bundles"), mustExist = false)
        SystemFileSystem.delete(root, mustExist = false)
        runBlocking { database.closeWhenIdle() }
    }
}

/** Waits up to 20 seconds for [condition], printing the tree when it never holds. */
@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u1WaitOrDump(what: String, condition: () -> Boolean) {
    try {
        waitUntil(timeoutMillis = 20_000, condition = condition)
    } catch (e: Throwable) {
        throw AssertionError("Timed out waiting for $what\n" + onRoot(useUnmergedTree = true).printToString(), e)
    }
}

/** Waits for a node that [matcher] finds, then returns it. */
@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u1WaitForNode(matcher: SemanticsMatcher, what: String = matcher.description): SemanticsNodeInteraction {
    u1WaitOrDump(what) { onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
    return onNode(matcher)
}

@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u1WaitForTag(tag: String): SemanticsNodeInteraction = u1WaitForNode(hasTestTag(tag))

@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u1WaitForText(text: String, substring: Boolean = false): SemanticsNodeInteraction =
    u1WaitForNode(hasText(text, substring = substring))

@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u1WaitGone(matcher: SemanticsMatcher, what: String = matcher.description) {
    u1WaitOrDump("$what to go") { onAllNodes(matcher).fetchSemanticsNodes().isEmpty() }
}

/** Waits until people features are ready at the Alpha conference and its bundle is installed. */
@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u1WaitReady(f: U1Fixture) {
    u1WaitOrDump("people features and the bundle") {
        f.controller.state.value.availability == PeopleAvailability.Ready && f.bundle != null
    }
}

// Profile (web ProfileScreen.tsx and TopicPicker.tsx) against the in-memory People API, with the
// Alpha conference's bundle for the topic pickers. Run on the iOS simulator and on Android.
@OptIn(ExperimentalTestApi::class)
class U1ProfileUiTest {
    private val f = U1Fixture()

    @AfterTest
    fun cleanUp() = f.close()

    private fun ComposeUiTest.showProfile(fontScale: Float = 1f) {
        u1WaitReady(f)
        setContent {
            TestPhone(fontScale) {
                CaddieTheme {
                    val state by f.controller.state.collectAsState()
                    val core by f.core.state.collectAsState()
                    val bundle = (core.bundle as? BundleState.Ready)?.bundle
                    ProfileScreen(state, f.host, PeopleTalks(bundle, core.interested, f.clock.ms))
                }
            }
        }
        u1WaitForTag("profile-name")
    }

    private fun ComposeUiTest.type(tag: String, text: String) {
        onNodeWithTag(tag).performScrollTo().typeText(text)
    }

    private fun ComposeUiTest.chip(picker: String, group: String, name: String): SemanticsNodeInteraction =
        onNode(hasContentDescription(name) and hasAnyAncestor(hasTestTag("$picker-$group")))

    private val visibleLabel = ProfileStrings.visibleAt("Alpha Conference")

    @Test
    fun aProfileNeedsANameBeforeItCanBeVisible() = runComposeUiTest {
        showProfile()
        onNodeWithText(ProfileStrings.ABOUT_YOU).assertIsDisplayed()
        onNodeWithText(PeopleCommonStrings.VISIBILITY_NOTICE).performScrollTo().assertIsDisplayed()

        // Visible with no name: the controller's message, and nothing is sent.
        onNodeWithText(visibleLabel).performScrollTo().performClick()
        u1WaitForText("Add your name to your profile first.")
        assertTrue(f.server.requests("PUT", "/api/people/profile").isEmpty())
        assertEquals(false, f.controller.state.value.visibility.openToMeet)

        // The caps cut what is typed, as the web's maxLength does.
        type("profile-name", "x".repeat(70))
        u1WaitOrDump("a 60-character name") { f.controller.state.value.profile.displayName == "x".repeat(60) }
        type("profile-about-me", "y".repeat(300))
        u1WaitOrDump("a 280-character about") { f.controller.state.value.profile.about.length == 280 }
        type("profile-contact", "z".repeat(130))
        u1WaitOrDump("a 120-character note") { f.controller.state.value.profile.contactNote.length == 120 }

        // A malformed LinkedIn link says how it should look, until it does.
        type("profile-linkedin", "linkedin.com/in/someone")
        u1WaitForText(ProfileStrings.LINKEDIN_INVALID)
        type("profile-linkedin", "https://www.linkedin.com/in/someone")
        u1WaitGone(hasText(ProfileStrings.LINKEDIN_INVALID))
    }

    @Test
    fun savingSendsTheExactProfileAndVisibilityRemovesIt() = runComposeUiTest {
        showProfile()
        type("profile-name", "Jordan Rivera")
        type("profile-about-me", "Platform engineer.")
        type("profile-interests", "Postgres failover")
        type("profile-expertise", "Ran Argo CD rollouts")
        type("profile-linkedin", "https://www.linkedin.com/in/jordan-rivera")
        type("profile-contact", "@jordan on the CNCF Slack")
        chip("picker-learn", "common", "eBPF, 1 talk").performScrollTo().performClick()
        chip("picker-speak", "common", "Kubernetes, 2 talks").performScrollTo().performClick()
        u1WaitOrDump("the topics on the device") {
            val t = f.controller.state.value.topics
            t.learn.map { it.topicId } == listOf("ebpf") && t.speak.map { it.topicId } == listOf("kubernetes")
        }

        // Visible: one PUT with exactly the profile typed, the topic ids, and open_to_meet.
        onNodeWithText(visibleLabel).performScrollTo().performClick()
        u1WaitOrDump("the profile PUT") { f.server.requests("PUT", "/api/people/profile").isNotEmpty() }
        val body = f.server.requests("PUT", "/api/people/profile").first().body!!
        assertEquals(JsonPrimitive(f.slug), body["event"])
        assertEquals(JsonPrimitive(true), body["open_to_meet"])
        assertEquals(
            buildJsonObject {
                put("display_name", "Jordan Rivera")
                put("about", "Platform engineer.")
                put("interests", "Postgres failover")
                put("expertise", "Ran Argo CD rollouts")
                putJsonArray("learn_topics") { add(JsonPrimitive("ebpf")) }
                putJsonArray("speak_topics") { add(JsonPrimitive("kubernetes")) }
                put("linkedin_url", "https://www.linkedin.com/in/jordan-rivera")
                put("contact_note", "@jordan on the CNCF Slack")
            },
            body["profile"],
        )
        assertEquals(JsonArray(emptyList()), body["shared_talk_ids"] ?: JsonArray(emptyList()))
        u1WaitOrDump("visible on the device") { f.controller.state.value.visibility.openToMeet }
        assertEquals("Jordan Rivera", f.server.me(f.slug)?.displayName)

        // Two reports hide the profile; the next save brings the owner's banner.
        val me = f.server.me(f.slug)!!
        f.server.seedPerson(f.slug, "Casey").report(me.ref)
        f.server.seedPerson(f.slug, "Devon").report(me.ref)
        type("profile-about-me", "Platform engineer, Postgres on bare metal.")
        u1WaitForTag("profile-hidden-banner")
        onNodeWithText("${ProfileStrings.HIDDEN_TITLE} ${ProfileStrings.HIDDEN_COPY}").performScrollTo().assertIsDisplayed()
        u1WaitForText(ProfileStrings.SAVED)

        // Off again, with no shared talks: the server copy goes.
        onNodeWithText(visibleLabel).performScrollTo().performClick()
        u1WaitOrDump("the server copy to go") { f.server.me(f.slug) == null && !f.controller.state.value.visibility.openToMeet }
        assertTrue(f.server.requests("DELETE", "/api/people/profile").isNotEmpty())
    }

    @Test
    fun topicsArePickedAndUnpickedWithoutMovingTheLists() = runComposeUiTest {
        showProfile()
        onNodeWithText(ProfileStrings.LEARN_TITLE).assertIsDisplayed()
        onNode(hasText(ProfileStrings.topicCount(0)) and hasAnyAncestor(hasTestTag("picker-learn"))).assertIsDisplayed()

        // Pick: the chip turns on where it is and joins the chosen row.
        chip("picker-learn", "common", "eBPF, 1 talk").performScrollTo().performClick()
        u1WaitForNode(hasContentDescription("eBPF") and hasAnyAncestor(hasTestTag("picker-learn-chosen")))
        u1WaitOrDump("eBPF learned") { f.controller.state.value.topics.learn.map { it.topicId } == listOf("ebpf") }
        onNode(hasText(ProfileStrings.topicCount(1)) and hasAnyAncestor(hasTestTag("picker-learn"))).assertIsDisplayed()
        chip("picker-learn", "common", "eBPF, 1 talk").assertIsDisplayed()

        // Unpick from the chosen row: it lingers as a ghost, then the row settles.
        chip("picker-learn", "chosen", "eBPF").performClick()
        u1WaitOrDump("eBPF unlearned") { f.controller.state.value.topics.learn.isEmpty() }
        u1WaitGone(hasTestTag("picker-learn-chosen"))

        // The search filters the bundle's topics on the device.
        onNodeWithTag("picker-learn-search").performScrollTo().typeText("kub")
        u1WaitForNode(hasContentDescription("Kubernetes, 2 talks") and hasAnyAncestor(hasTestTag("picker-learn-matching")))
        // Subheads are drawn in capitals, as the web's text-transform does.
        onNode(hasText(ProfileStrings.COMMON_AT_CONFERENCE.uppercase()) and hasAnyAncestor(hasTestTag("picker-learn"))).assertDoesNotExist()
        onNodeWithTag("picker-learn-search").typeText("zzzz")
        u1WaitForText(ProfileStrings.NO_TOPIC_MATCH)
        onNode(hasContentDescription(ProfileStrings.CLEAR) and hasAnyAncestor(hasTestTag("picker-learn"))).performClick()
        u1WaitForNode(hasText(ProfileStrings.COMMON_AT_CONFERENCE.uppercase()) and hasAnyAncestor(hasTestTag("picker-learn")))

        // Free text suggests the topics it names.
        type("profile-interests", "Getting better at Kubernetes upgrades")
        u1WaitForNode(hasContentDescription("Kubernetes, 2 talks") and hasAnyAncestor(hasTestTag("picker-learn-suggested")))
        onNode(hasText(ProfileStrings.SUGGESTED_FOR_YOU.uppercase()) and hasAnyAncestor(hasTestTag("picker-learn"))).assertExists()
    }

    @Test
    fun deletingMyProfileClearsTheServerAndTheDevice() = runComposeUiTest {
        showProfile()
        type("profile-name", "Jordan Rivera")
        onNodeWithText(visibleLabel).performScrollTo().performClick()
        u1WaitOrDump("visible") { f.server.me(f.slug) != null && f.controller.state.value.visibility.openToMeet }

        // The confirmation is an inline notice, not a dialog.
        onNodeWithTag("profile-delete").performScrollTo().performClick()
        u1WaitForTag("profile-delete-confirm")
        onNodeWithText(ProfileStrings.DELETE_CONFIRM).assertIsDisplayed()
        onNodeWithTag("profile-delete-now").performScrollTo().performClick()

        u1WaitForText(DELETED_MESSAGE)
        assertNull(f.server.me(f.slug))
        assertTrue(f.server.requests("DELETE", "/api/people/profile").any { it.query == "event=${f.slug}" })
        u1WaitOrDump("the device cleared") { f.controller.state.value.profile == Profile.EMPTY }
        u1WaitGone(hasText("Jordan Rivera"))
        onNodeWithTag("profile-delete-confirm").assertDoesNotExist()
        assertEquals(false, f.controller.state.value.visibility.openToMeet)
    }

    @Test
    fun anUnfinishedDeleteIsTriedAgain() = runComposeUiTest {
        showProfile()
        type("profile-name", "Jordan Rivera")
        onNodeWithText(visibleLabel).performScrollTo().performClick()
        u1WaitOrDump("visible") { f.server.me(f.slug) != null && f.controller.state.value.visibility.openToMeet }

        f.server.failNextDeletes(1, status = 503)
        onNodeWithTag("profile-delete").performScrollTo().performClick()
        onNodeWithTag("profile-delete-now").performScrollTo().performClick()

        // The banner says what is held back; the confirmation stays open with the failure under it.
        // The conference's copy may be gone already (a 503 can come after the delete), so the banner
        // says it may be hidden, as the web's does while any conference's removal is unfinished.
        u1WaitForTag("profile-pending-delete")
        onNodeWithText(
            "${ProfileStrings.DELETING_UNFINISHED} ${ProfileStrings.PENDING_HIDDEN_COPY} ${ProfileStrings.PENDING_DELETE_COPY}",
        ).performScrollTo().assertIsDisplayed()
        u1WaitForTag("profile-delete-message")
        onNodeWithTag("profile-delete-confirm").assertExists()
        assertTrue(f.server.me(f.slug) != null)
        assertTrue(f.controller.state.value.deletes.deleteAll)

        // Try again runs the whole delete, so the device's data goes too.
        onNodeWithTag("profile-try-again").performScrollTo().performClick()
        u1WaitGone(hasTestTag("profile-pending-delete"))
        u1WaitForText(DELETED_MESSAGE)
        assertNull(f.server.me(f.slug))
        u1WaitOrDump("the device cleared") { f.controller.state.value.profile == Profile.EMPTY }
    }

    @Test
    fun anUnfinishedRemovalFromThisConferenceNamesIt() = runComposeUiTest {
        showProfile()
        type("profile-name", "Jordan Rivera")
        onNodeWithText(visibleLabel).performScrollTo().performClick()
        u1WaitOrDump("visible") { f.server.me(f.slug) != null && f.controller.state.value.visibility.openToMeet }

        // Turning visibility off removes the server copy; the removal fails once.
        f.server.failNextDeletes(1, status = 503)
        onNodeWithText(visibleLabel).performScrollTo().performClick()
        u1WaitForTag("profile-pending-delete")
        onNodeWithText(
            "${ProfileStrings.removingUnfinished("Alpha Conference")} ${ProfileStrings.PENDING_HIDDEN_COPY} ${ProfileStrings.PENDING_DELETE_ONE_COPY}",
        ).performScrollTo().assertIsDisplayed()
        assertEquals(listOf(f.slug), f.controller.state.value.deletes.pendingSlugs)

        onNodeWithTag("profile-try-again").performScrollTo().performClick()
        u1WaitGone(hasTestTag("profile-pending-delete"))
        assertNull(f.server.me(f.slug))
    }

    @Test
    fun profileReadsAtTwiceTheFontSize() = runComposeUiTest {
        showProfile(fontScale = 2f)
        onNodeWithText(ProfileStrings.ABOUT_YOU).assertIsDisplayed()
        onNodeWithTag("profile-name").performScrollTo().assertIsDisplayed()
        onNodeWithText(ProfileStrings.LEARN_TITLE).performScrollTo().assertIsDisplayed()
        chip("picker-learn", "common", "Scheduling, 1 talk").performScrollTo().assertIsDisplayed()
        onNodeWithText(ProfileStrings.REACH_TITLE).performScrollTo().assertIsDisplayed()
        onNodeWithText(visibleLabel).performScrollTo().assertIsDisplayed()
        onNodeWithTag("profile-delete").performScrollTo().assertIsDisplayed()
        onNodeWithText(ProfileStrings.DELETE_MY_PROFILE).assertIsDisplayed()
        // At this size a row's touch target still holds its text.
        val delete = onNodeWithTag("profile-delete").fetchSemanticsNode()
        assertTrue(delete.size.height >= 44 * delete.layoutInfo.density.density - 1)
    }

    private companion object {
        /** ProfileSync.DELETED_MESSAGE, which the controller returns once "Delete my profile" has finished. */
        const val DELETED_MESSAGE = "Your profile was deleted from this phone and from our server."
    }
}

/** The circle count the controller words for [n] people, as the web does. */
internal fun u1CountLabel(n: Int) = PeopleText.peopleCountLabel(n)
