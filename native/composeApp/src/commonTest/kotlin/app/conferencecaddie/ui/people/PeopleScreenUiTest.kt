package app.conferencecaddie.ui.people

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToKey
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.runComposeUiTest
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.people.PeopleAvailability
import app.conferencecaddie.shared.people.TopicRef
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.PeoplePage
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
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

// The People home (web PeopleScreen.tsx) over the real controller and FakePeopleServer: the
// prompts, the search with its highlighted evidence and its pages, Around now, the Around home, and
// the requests other screens leave for it. Run on the iOS simulator and on Android.
@OptIn(ExperimentalTestApi::class)
class PeopleScreenUiTest {
    private val rig = U2Rig()

    @AfterTest
    fun cleanUp() = rig.close()

    private fun matchesBodies() = rig.server.requests("POST", "/api/people/matches").map { it.body!! }

    @Test
    fun withoutANameTheHomeAsksForAProfile() = runComposeUiTest {
        u2Ready(rig, name = null, visible = false)
        u2Show(rig)
        u2WaitForTag("people-create-profile")
        onNodeWithText(PeopleStrings.PEOPLE_TO_MEET).assertIsDisplayed()
        onNodeWithText(PeopleStrings.SEARCH_PLACEHOLDER).assertIsDisplayed()
        onNodeWithText(PeopleStrings.AROUND_NOW).assertIsDisplayed()
        onNodeWithText(PeopleStrings.CREATE_TITLE).assertIsDisplayed()
        onNodeWithText(PeopleStrings.CREATE_BODY).assertIsDisplayed()
        onNodeWithText(PeopleStrings.CREATE_ACTION).performClick()
        runOnIdle { assertEquals(listOf<PeoplePage>(PeoplePage.Profile), rig.nav.pages) }
        assertTrue(matchesBodies().isEmpty())
    }

    @Test
    fun theVisibilityPromptMakesMeVisible() = runComposeUiTest {
        u2Ready(rig, visible = false)
        val ada = rig.server.seedPerson(rig.slug, "Ada Seed", about = "Platform engineer.", expertise = "Ran eBPF tracing for 200 clusters.", speakTopics = listOf("ebpf"))
        u2Show(rig)
        u2WaitForTag("people-visibility-prompt")
        onNodeWithText(PeopleStrings.VISIBILITY_TITLE).assertIsDisplayed()
        onNodeWithText(PeopleStrings.VISIBILITY_BODY).assertIsDisplayed()
        onNodeWithText(PeopleCommonStrings.VISIBILITY_NOTICE).assertExists()
        assertTrue(matchesBodies().isEmpty(), "nothing is searched before I am visible")

        onNodeWithTag("people-screen").performScrollToNode(hasText(PeopleStrings.MAKE_VISIBLE))
        onNodeWithText(PeopleStrings.MAKE_VISIBLE).performClick()
        u2WaitForTag("person-${ada.ref}")
        onNodeWithTag("people-visibility-prompt").assertDoesNotExist()
        assertTrue(rig.state.visibility.openToMeet)
        val put = rig.server.requests("PUT", "/api/people/profile").last().body!!
        assertEquals(true, put["open_to_meet"]?.jsonPrimitive?.content?.toBoolean())
        // People to meet: no query and no "when".
        val body = matchesBodies().last()
        assertNull(body["query"])
        assertNull(body["when"])
        onNodeWithText(PeopleStrings.PEOPLE_TO_MEET).assertIsDisplayed()
    }

    @Test
    fun searchHighlightsTheEvidenceAndPagesAsTheListScrolls() = runComposeUiTest {
        u2Ready(rig)
        val people = (1..25).map { i ->
            rig.server.seedPerson(rig.slug, "Person ${i.toString().padStart(2, '0')}", about = "Engineer $i.", expertise = "Ran Kubernetes upgrades for $i clusters.")
        }
        u2Show(rig)
        u2WaitForTag("people-search-field")
        onNodeWithTag("people-search-field").typeText("kubernetes")
        u2WaitForText(PeopleStrings.PEOPLE_WHO_MATCH)
        u2WaitForTag("person-${people.first().ref}")

        // The evidence, with "Kubernetes" marked, shown once (the opener and reason repeat it). The
        // heading changes as the text is typed, and the cards of the list before the search can
        // still show until the search answers, so this waits for the search's own card.
        fun highlighted(): Boolean = runCatching {
            val shown = onNode(u2InCard(people.first().ref, "Ran Kubernetes upgrades for 1 clusters.")).fetchSemanticsNode().config[SemanticsProperties.Text].single()
            shown.spanStyles.any { shown.text.substring(it.start, it.end) == "Kubernetes" }
        }.getOrDefault(false)
        waitUntil(timeoutMillis = 20_000) { highlighted() }
        onNode(u2InCard(people.first().ref, "Ran Kubernetes upgrades for 1 clusters.")).assertIsDisplayed()
        assertTrue(highlighted(), "Kubernetes is highlighted")
        val first = matchesBodies().last()
        assertEquals("kubernetes", first["query"]?.jsonPrimitive?.content)
        assertEquals("anyone", first["when"]?.jsonPrimitive?.content)
        assertNull(first["from"])

        // The end of the list asks for the next page, from 20.
        onNodeWithTag("people-more").assertDoesNotExist()
        onNodeWithTag("people-screen").performScrollToKey("more")
        waitUntil(timeoutMillis = 20_000) { matchesBodies().any { it["from"]?.jsonPrimitive?.content == "20" } }
        val second = matchesBodies().last { it["from"] != null }
        assertEquals("kubernetes", second["query"]?.jsonPrimitive?.content)
        assertEquals(JsonPrimitive(20), second["size"])
        waitUntil(timeoutMillis = 20_000) { runCatching { onNodeWithTag("people-screen").performScrollToNode(hasTestTag("person-${people.last().ref}")) }.isSuccess }
        onNodeWithTag("person-${people.last().ref}").assertIsDisplayed()
        // The last page said there is no more.
        onNodeWithTag("people-more").assertDoesNotExist()

        // A search nobody matches.
        onNodeWithTag("people-screen").performScrollToNode(hasTestTag("people-search-field"))
        onNodeWithTag("people-search-field").typeText("zzqqxx")
        u2WaitForText(PeopleStrings.SEARCH_EMPTY)
    }

    @Test
    fun aroundNowListsWhoIsAroundWithoutTheirZone() = runComposeUiTest {
        u2Ready(rig)
        val ada = rig.server.seedPerson(rig.slug, "Ada Seed", expertise = "Ran eBPF tracing.", speakTopics = listOf("ebpf"), around = "Hallway")
        val bo = rig.server.seedPerson(rig.slug, "Bo Seed", expertise = "Wrote eBPF maps.", speakTopics = listOf("ebpf"))
        u2Show(rig)
        u2WaitForTag("person-${bo.ref}")
        onNodeWithText(PeopleStrings.PEOPLE_TO_MEET).assertIsDisplayed()
        onNode(aroundNowChip).assertIsOff().performClick()
        u2WaitForNoTag("person-${bo.ref}")
        onNode(aroundNowChip).assertIsOn()
        onNodeWithText(PeopleStrings.PEOPLE_AROUND_NOW).assertIsDisplayed()
        assertEquals("around_now", matchesBodies().last()["when"]?.jsonPrimitive?.content)
        onNode(u2InCard(ada.ref, PeopleCommonStrings.around(null))).assertIsDisplayed()
        onAllNodes(hasText("Hallway", substring = true)).fetchSemanticsNodes().let { assertTrue(it.isEmpty(), "no zone while I am not around") }

        // Around, but not in my zone (I am not around): Ask to talk shop opens the ask sheet.
        onNode(u2InCard(ada.ref, PeopleStrings.ASK_TO_TALK_SHOP)).performClick()
        runOnIdle { assertEquals(ada.ref, rig.host.asking?.ref) }
    }

    @Test
    fun aNudgeLinkOpensAroundNowAndASearchRequestOpensTheSearch() = runComposeUiTest {
        u2Ready(rig)
        val ada = rig.server.seedPerson(rig.slug, "Ada Seed", expertise = "Ran Kubernetes upgrades.", around = "Hallway")
        u2Show(rig)
        u2WaitForTag("person-${ada.ref}")
        runOnIdle { rig.host.openPeople(PeopleRequest(aroundNow = true)) }
        u2WaitForText(PeopleStrings.PEOPLE_AROUND_NOW)
        onNode(aroundNowChip).assertIsOn()
        runOnIdle { assertNull(rig.host.request) }

        runOnIdle { rig.host.openPeople(PeopleRequest(query = "kubernetes")) }
        u2WaitForText(PeopleStrings.PEOPLE_WHO_MATCH)
        onNodeWithTag("people-search-field").assertTextEquals("kubernetes")
        onNode(aroundNowChip).assertIsOff()
        runOnIdle { assertNull(rig.host.request) }
        waitUntil(timeoutMillis = 20_000) { matchesBodies().lastOrNull()?.get("query")?.jsonPrimitive?.content == "kubernetes" }
    }

    @Test
    fun theAroundHomeGroupsByZoneAndOpensTheSearch() = runComposeUiTest {
        u2Ready(rig, zone = "Hallway")
        val ada = rig.server.seedPerson(rig.slug, "Ada Seed", expertise = "Ran eBPF tracing.", speakTopics = listOf("ebpf"), around = "Hallway")
        val bea = rig.server.seedPerson(rig.slug, "Bea Seed", expertise = "Wrote eBPF maps.", speakTopics = listOf("ebpf"), around = "Expo hall")
        val cy = rig.server.seedPerson(rig.slug, "Cy Seed", expertise = "Tuned eBPF probes.", speakTopics = listOf("ebpf"))
        u2Show(rig)
        u2WaitForTag("person-${ada.ref}")
        onNodeWithText(PeopleStrings.AROUND_TITLE).assertIsDisplayed()
        onNodeWithTag("people-search-field").assertDoesNotExist()
        onNodeWithText(PeopleStrings.inZone("Hallway").uppercase()).assertIsDisplayed()
        onNode(u2InCard(ada.ref, PeopleCommonStrings.around("Hallway"))).assertIsDisplayed()
        onNode(u2InCard(ada.ref, PeopleCommonStrings.BAND_SAME_ZONE)).assertIsDisplayed()
        runOnIdle { assertTrue(rig.state.around.visible) }

        u2ScrollToCard(bea.ref)
        onNodeWithTag("people-screen").performScrollToNode(hasText(PeopleStrings.ELSEWHERE.uppercase()))
        onNode(u2InCard(bea.ref, PeopleCommonStrings.around("Expo hall"))).assertExists()
        onNode(u2InCard(bea.ref, PeopleStrings.ASK_TO_TALK_SHOP)).assertExists()
        onNode(hasTestTag("person-${cy.ref}")).assertDoesNotExist()

        // Find someone specific: the search with Around now on, and the way back.
        onNodeWithTag("people-screen").performScrollToNode(hasTestTag("people-find"))
        onNodeWithTag("people-find").assertTextEquals(PeopleStrings.FIND_LABEL).performClick()
        u2WaitForTag("people-search-field")
        onNode(aroundNowChip).assertIsOn()
        onNodeWithText(PeopleStrings.PEOPLE_AROUND_NOW).assertIsDisplayed()
        onNodeWithTag("people-find").assertDoesNotExist()
        waitUntil(timeoutMillis = 20_000) { !rig.state.around.visible }
        onNodeWithTag("people-back-to-around").assertTextEquals(PeopleStrings.BACK_TO_AROUND).performClick()
        u2WaitForText(PeopleStrings.AROUND_TITLE)
        onNodeWithTag("people-search-field").assertDoesNotExist()
        waitUntil(timeoutMillis = 20_000) { rig.state.around.visible }
    }

    @Test
    fun theAppOpensASearchFromItsLaunchOption() = runComposeUiTest {
        val backend = TestBackend(people = true)
        val root = Path(SystemTemporaryDirectory, "caddie-u2-${Random.nextLong().toULong()}")
        SystemFileSystem.createDirectories(Path(root, "bundles"))
        val files = BundleFiles(Path(root, "bundles"))
        val database = CaddieDatabase.open(":memory:")
        val coreScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val core = CaddieCore(database, files, backend, coreScope, allowLocalHttp = false)
            core.setBackend(testBackendUrl(backend.base))
            rig.controller.bind(core.state)
            u2Await(rig) {
                rig.controller.state.first { it.availability == PeopleAvailability.Ready && it.zones.contains("Hall A") }
                rig.controller.updateProfile { it.copy(displayName = "Me Myself") }
                rig.controller.setTopics(learn = listOf(TopicRef("ebpf", "eBPF")), speak = emptyList())
                assertNull(rig.controller.setOpenToMeet(true))
            }
            val kim = rig.server.seedPerson(rig.slug, "Kim Seed", expertise = "Ran Kubernetes upgrades for 40 clusters.")
            setContent { TestPhone { CaddieApp(core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(people = "search:kubernetes"), people = rig.controller) } }
            u2WaitForTag("person-${kim.ref}")
            onNodeWithText(PeopleStrings.PEOPLE_WHO_MATCH).assertIsDisplayed()
            onNodeWithTag("people-search-field").assertTextEquals("kubernetes")
            onNode(u2InCard(kim.ref, "Ran Kubernetes upgrades for 40 clusters.")).assertIsDisplayed()
            assertFalse(rig.server.requests("POST", "/api/people/matches").isEmpty())
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
}

/** The toggle of the "Around now" chip (a CaddieChip, whose toggle sits inside the tagged pill). */
private val aroundNowChip = hasAnyAncestor(hasTestTag("around-now-chip")) and isToggleable()
