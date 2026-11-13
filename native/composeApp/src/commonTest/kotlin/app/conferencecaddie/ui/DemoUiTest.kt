package app.conferencecaddie.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.Demo
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.bundle.BundleStatus
import app.conferencecaddie.shared.bundle.Conference
import app.conferencecaddie.shared.bundle.IndexedConference
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.ui.components.DEMO_NOTE_TAG
import app.conferencecaddie.ui.components.DEMO_PILL_TAG
import app.conferencecaddie.ui.components.DemoNote
import app.conferencecaddie.ui.components.TalkCard
import app.conferencecaddie.ui.components.showsDemoLabel
import app.conferencecaddie.ui.shell.ConferenceItem
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.PeoplePage
import app.conferencecaddie.ui.shell.ShellNavigation
import app.conferencecaddie.ui.shell.ShellState
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.shell.TabContent
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.talks.CaddieApp
import app.conferencecaddie.ui.talks.FixedEmbedder
import app.conferencecaddie.ui.talks.TalkLaunch
import app.conferencecaddie.ui.talks.TestBackend
import app.conferencecaddie.ui.talks.conferenceItem
import app.conferencecaddie.ui.talks.shareText
import app.conferencecaddie.ui.theme.CaddieTheme
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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

// The "Demo" label of a demo conference (a conference entry with "demo": true): the switcher, the
// app bar, talk cards and the note at the top of each screen. Run on the iOS simulator and on an
// Android device or emulator, as the other UI tests are.
@OptIn(ExperimentalTestApi::class)
class DemoUiTest {
    // Alpha is published as a demo conference before the core exists, so the core never reads the
    // list without it; it is listed first, so the app opens it.
    private val backend = TestBackend().also { it.publish(listOf(it.alpha.asDemo(), it.beta)) }
    private val root = Path(SystemTemporaryDirectory, "caddie-demo-${Random.nextLong().toULong()}")
    private val database = CaddieDatabase.open(":memory:")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val files = BundleFiles(Path(root, "bundles")).also { SystemFileSystem.createDirectories(Path(root, "bundles")) }
    private val core = CaddieCore(database, files, backend, scope, allowLocalHttp = false).also {
        it.setBackend(BackendUrl.normalise(backend.base) as BackendUrl.Valid)
    }

    @AfterTest
    fun cleanUp() = runTest {
        scope.coroutineContext.job.cancelAndJoin()
        files.clear()
        SystemFileSystem.delete(Path(root, "bundles"), mustExist = false)
        SystemFileSystem.delete(root, mustExist = false)
        database.closeWhenIdle()
    }

    private fun conference(demo: Boolean) = Conference(
        slug = "caddie-demo-conference",
        name = "Caddie Demo Conference",
        startDate = "2099-03-02",
        endDate = "2099-03-04",
        timeZone = "UTC",
        location = Conference.Location("Demo City", "", "", false),
        status = "searchable",
        officialScheduleUrl = null,
        source = "demo",
        hasLevel = false,
        trackGroup = null,
        tagGroups = emptyList(),
        talkCount = 0,
        demo = demo,
    )

    private fun ComposeUiTest.waitForTag(tag: String) {
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun SemanticsNodeInteraction.description(): String? =
        fetchSemanticsNode().config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString()

    @Test
    fun theLabelShowsOnlyForTheLiteralTrue() {
        assertTrue(showsDemoLabel(true))
        assertFalse(showsDemoLabel(false))
        assertFalse(showsDemoLabel(null))
    }

    @Test
    fun theSwitcherItemAndTheSharedListCarryTheMark() {
        assertTrue(conferenceItem(IndexedConference(conference(demo = true), null, BundleStatus.None)).demo)
        assertFalse(conferenceItem(IndexedConference(conference(demo = false), null, BundleStatus.None)).demo)
        assertEquals("My schedule at Caddie Demo Conference (Demo)", shareText(conference(demo = true), emptyList()))
        assertEquals("My schedule at Caddie Demo Conference", shareText(conference(demo = false), emptyList()))
    }

    @Test
    fun aTalkCardAndTheNoteShowThePillOnlyForADemoConference() = runComposeUiTest {
        setContent {
            CaddieTheme {
                Column {
                    TalkCard(title = "Invented talk", whenText = "Tue", demo = true, modifier = Modifier.testTag("demo-card"))
                    TalkCard(title = "Real talk", whenText = "Tue", modifier = Modifier.testTag("real-card"))
                    DemoNote(true, Modifier.testTag("demo-note-on"))
                    DemoNote(false, Modifier.testTag("demo-note-off"))
                }
            }
        }
        val pill = onNode(hasTestTag(DEMO_PILL_TAG) and hasAnyAncestor(hasTestTag("demo-card")), useUnmergedTree = true)
        assertEquals(Demo.SPOKEN, pill.description())
        onNode(hasTestTag(DEMO_PILL_TAG) and hasAnyAncestor(hasTestTag("real-card")), useUnmergedTree = true).assertDoesNotExist()
        onNode(hasText(Demo.NOTE) and hasAnyAncestor(hasTestTag("demo-note-on")), useUnmergedTree = true).assertExists()
        onNodeWithTag("demo-note-off").assertDoesNotExist()
    }

    @Test
    fun theAppBarAndTheSwitcherNameADemoConference() = runComposeUiTest {
        val state = ShellState(
            capabilities = Capabilities(),
            conferences = listOf(
                ConferenceItem("caddie-demo-conference", "Caddie Demo Conference", "Mar 2–4, 2099 · Demo City", demo = true),
                ConferenceItem("alpha-conf-2099", "Alpha Conference", "Mar 3, 2099 · Test City, Testland"),
            ),
            selectedConferenceId = "caddie-demo-conference",
            appVersion = "test",
        )
        setContent { App(state) }
        val switcher = onNodeWithTag("conference-switcher")
        assertEquals("Caddie Demo Conference, ${Demo.SPOKEN}, change conference", switcher.description())
        onNode(hasTestTag(DEMO_PILL_TAG) and hasAnyAncestor(hasTestTag("conference-switcher")), useUnmergedTree = true).assertExists()

        switcher.performClick()
        waitForTag("switcher-sheet")
        val inSheet = hasAnyAncestor(hasTestTag("switcher-sheet"))
        // One pill in the sheet: the demo conference's row, not the real one's.
        assertEquals(1, onAllNodes(hasTestTag(DEMO_PILL_TAG) and inSheet, useUnmergedTree = true).fetchSemanticsNodes().size)
    }

    @Test
    fun theProfileRequestsAndMeetUpTitlesCarryThePillButSettingsDoesNot() = runComposeUiTest {
        val nav = ShellNavigation()
        val state = ShellState(
            capabilities = Capabilities(people = Capabilities.People(enabled = true)),
            conferences = listOf(ConferenceItem("caddie-demo-conference", "Caddie Demo Conference", "Mar 2–4, 2099 · Demo City", demo = true)),
            selectedConferenceId = "caddie-demo-conference",
            appVersion = "test",
        )
        setContent { App(state, content = TabContent(peoplePage = { Box(Modifier.fillMaxSize()) }), navigation = nav) }
        val pills = { onAllNodes(hasTestTag(DEMO_PILL_TAG), useUnmergedTree = true).fetchSemanticsNodes().size }
        for ((page, title) in listOf(PeoplePage.Profile to Strings.AppBar.PROFILE, PeoplePage.Inbox to Strings.AppBar.REQUESTS, PeoplePage.Meet("m1") to Strings.AppBar.MEET_UP)) {
            nav.openPage(page)
            waitForIdle()
            assertTrue(onAllNodes(hasText(title)).fetchSemanticsNodes().isNotEmpty(), "$title is showing")
            assertEquals(1, pills(), "$title has the pill")
            onNode(hasTestTag(DEMO_PILL_TAG), useUnmergedTree = true).let { assertEquals(Demo.SPOKEN, it.description()) }
        }
        nav.openSettings()
        waitForIdle()
        assertTrue(onAllNodes(hasText(Strings.Settings.TITLE)).fetchSemanticsNodes().isNotEmpty(), "Settings is showing")
        assertEquals(0, pills(), "Settings has none")
    }

    @Test
    fun thePlaceholdersOfADemoConferenceKeepTheNote() = runComposeUiTest {
        setContent {
            CaddieTheme {
                Column {
                    Box(Modifier.testTag("people-off")) { PeoplePlaceholder(online = false, demo = true) }
                    Box(Modifier.testTag("for-you-off")) { ForYouPlaceholder(online = false, demo = true) }
                    Box(Modifier.testTag("real-off")) { PeoplePlaceholder(online = false) }
                }
            }
        }
        onNode(hasTestTag(DEMO_NOTE_TAG) and hasAnyAncestor(hasTestTag("people-off"))).assertExists()
        onNode(hasTestTag(DEMO_NOTE_TAG) and hasAnyAncestor(hasTestTag("for-you-off"))).assertExists()
        onNode(hasTestTag(DEMO_NOTE_TAG) and hasAnyAncestor(hasTestTag("real-off"))).assertDoesNotExist()
    }

    @Test
    fun forYouOfADemoConferenceOpensWithTheNoteAndItsCardsCarryThePill() = runComposeUiTest {
        setContent {
            CaddieApp(
                core,
                isDebugBuild = false,
                appVersion = "test",
                launch = DebugLaunch(tab = Tab.ForYou),
                talkLaunch = TalkLaunch(learn = listOf("kubernetes")),
                embedder = { FixedEmbedder(mapOf("kubernetes" to 1)) },
            )
        }
        waitForTag("for-you-alpha-conf-2099:3")
        onNode(hasTestTag(DEMO_NOTE_TAG) and hasAnyAncestor(hasTestTag("for-you-screen"))).assertExists()
        onNode(hasTestTag(DEMO_PILL_TAG) and hasAnyAncestor(hasTestTag("for-you-alpha-conf-2099:3")), useUnmergedTree = true).assertExists()
    }

    @Test
    fun interestedOfADemoConferenceOpensWithTheNoteEmptyOrNot() = runComposeUiTest {
        setContent { CaddieApp(core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Interested), embedder = null) }
        // Empty: the placeholder opens with the note.
        waitForTag(DEMO_NOTE_TAG)
        onNodeWithText(Strings.Interested.EMPTY).assertExists()
        // With a marked talk: the list opens with the note, and the card carries the pill.
        core.setInterested("alpha-conf-2099:1", true)
        waitForTag("interested-screen")
        waitForTag("talk-alpha-conf-2099:1")
        onNode(hasTestTag(DEMO_NOTE_TAG) and hasAnyAncestor(hasTestTag("interested-screen"))).assertExists()
        onNode(hasTestTag(DEMO_PILL_TAG) and hasAnyAncestor(hasTestTag("talk-alpha-conf-2099:1")), useUnmergedTree = true).assertExists()
    }

    @Test
    fun aDemoConferenceFromTheBackendIsLabelledOnItsScreens() = runComposeUiTest {
        setContent { CaddieApp(core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Search), embedder = null) }

        // The Search tab: the note at the top of the results, scrolling with them, and a pill on each talk card.
        waitForTag("talk-alpha-conf-2099:1")
        waitForTag(DEMO_NOTE_TAG)
        onNode(hasTestTag(DEMO_NOTE_TAG) and hasAnyAncestor(hasTestTag("search-results"))).assertExists()
        onNode(hasTestTag(DEMO_PILL_TAG) and hasAnyAncestor(hasTestTag("talk-alpha-conf-2099:1")), useUnmergedTree = true).assertExists()
        onNode(hasTestTag(DEMO_PILL_TAG) and hasAnyAncestor(hasTestTag("conference-switcher")), useUnmergedTree = true).assertExists()

        // The talk sheet.
        onNode(hasText("Intro to eBPF tracing"), useUnmergedTree = true).performClick()
        waitForTag("talk-sheet")
        onNode(hasTestTag(DEMO_PILL_TAG) and hasAnyAncestor(hasTestTag("talk-sheet-card")), useUnmergedTree = true).assertExists()
    }
}
