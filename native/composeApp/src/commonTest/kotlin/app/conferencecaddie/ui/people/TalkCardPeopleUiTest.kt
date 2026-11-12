package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToKey
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.TestDevice
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.talks.CaddieApp
import app.conferencecaddie.ui.talks.TestBackend
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonPrimitive

// The people controls of the Search results and the For you cards (web talk.tsx and ForYou.tsx draw
// TalkPeopleControls on every talk card): the count of people who share for a talk, the share
// switch on a marked talk, and the counts of a page of results asked for together. The app is
// CaddieApp on TestBackend with a real controller over the in-memory People API. Run on the iOS
// simulator and on Android.
@OptIn(ExperimentalTestApi::class)
class TalkCardPeopleUiTest {
    private var fixture: U1Fixture? = null
    private val f: U1Fixture get() = fixture ?: U1Fixture().also { fixture = it }
    private val talk1 = "alpha-conf-2099:1"
    private val talk3 = "alpha-conf-2099:3"
    private val talk4 = "alpha-conf-2099:4"

    @AfterTest
    fun cleanUp() {
        fixture?.close()
    }

    /** People ready, a named profile on this device (visible to nobody yet), [learn] for For you and [interested] marked. */
    private fun ComposeUiTest.prepare(interested: List<String> = emptyList(), learn: List<String> = emptyList()) {
        u1WaitReady(f)
        f.act { f.controller.updateProfile { it.copy(displayName = "Jordan Rivera", about = "Platform engineer.") } }
        interested.forEach { f.core.setInterested(it, true) }
        if (learn.isNotEmpty()) f.core.setLearnTopics(learn)
        u1WaitOrDump("the Interested list and the learn topics") {
            val s = f.core.state.value
            s.interested.containsAll(interested) && s.learn.topics == learn && f.controller.state.value.profile.displayName == "Jordan Rivera"
        }
    }

    /**
     * Waits for a node inside a card. A talk card is one button for screen readers, so its texts
     * are only in the unmerged tree.
     */
    private fun ComposeUiTest.waitInCard(matcher: SemanticsMatcher) =
        u1WaitOrDump(matcher.description) { onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

    private fun ComposeUiTest.assertNoControls(talkId: String) =
        onAllNodes(hasTestTag("talk-people-$talkId"), useUnmergedTree = true).assertCountEquals(0)

    /** The circle-count requests the fake has had so far. */
    private fun countRequests(): List<Set<String>> =
        f.server.requests("POST", "/api/circles/counts").map { r -> (r.body!!["talk_ids"] as JsonArray).map { it.jsonPrimitive.content }.toSet() }

    @Test
    fun searchResultsCarryThePeopleControls() = runComposeUiTest {
        f.server.seedPerson(f.slug, "Sample · Avery", about = "Placeholder profile 1.", sharedTalkIds = listOf(talk1))
        prepare(interested = listOf(talk3))
        setContent { TestPhone { CaddieApp(f.core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Search), people = f.controller) } }
        u1WaitForTag("search-results")

        // Talk 1: someone shares for it, so its card counts them; it is not marked, so no switch.
        waitInCard(hasText(u1CountLabel(1)) and hasAnyAncestor(hasTestTag("talk-people-$talk1")))
        onAllNodes(hasTestTag("share-switch-$talk1"), useUnmergedTree = true).assertCountEquals(0)

        // Talk 3 is marked: its card has the share switch, and sharing from it asks first.
        onNodeWithTag("search-results", useUnmergedTree = true).performScrollToNode(hasTestTag("share-switch-$talk3"))
        onNodeWithTag("share-switch-$talk3", useUnmergedTree = true).performClick()
        waitInCard(hasTestTag("share-notice"))
        assertTrue(f.server.requests("PUT", "/api/people/profile").isEmpty())
        onNodeWithText(ProfileStrings.SHARE_MY_PROFILE).performScrollTo().performClick()
        u1WaitOrDump("the share") { f.controller.state.value.visibility.sharedTalkIds == listOf(talk3) }
        waitInCard(hasText(u1CountLabel(1)) and hasAnyAncestor(hasTestTag("talk-people-$talk3")))
        onAllNodes(hasTestTag("see-who-$talk3"), useUnmergedTree = true).assertCountEquals(1)

        // Talk 4: neither marked nor shared by anyone, so nothing once its count is known.
        onNodeWithTag("search-results", useUnmergedTree = true).performScrollToNode(hasTestTag("talk-$talk4"))
        u1WaitOrDump("talk 4's count") { countRequests().any { talk4 in it } }
        waitForIdle()
        assertNoControls(talk4)
    }

    @Test
    fun forYouCardsCarryThePeopleControls() = runComposeUiTest {
        f.server.seedPerson(f.slug, "Sample · Avery", about = "Placeholder profile 1.", sharedTalkIds = listOf(talk1))
        f.server.seedPerson(f.slug, "Sample · Blake", about = "Placeholder profile 2.", sharedTalkIds = listOf(talk1))
        prepare(learn = listOf("ebpf", "kubernetes"))
        setContent { TestPhone { CaddieApp(f.core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.ForYou), people = f.controller) } }
        u1WaitForTag("for-you-$talk1")

        // The eBPF talk: two people share for it, counted inside its card, under the actions.
        waitInCard(hasText(u1CountLabel(2)) and hasAnyAncestor(hasTestTag("talk-people-$talk1")) and hasAnyAncestor(hasTestTag("for-you-$talk1")))
        onAllNodes(hasTestTag("share-switch-$talk1"), useUnmergedTree = true).assertCountEquals(0)

        // A Kubernetes talk nobody shares for has no controls once its count is known.
        onNodeWithTag("for-you-screen", useUnmergedTree = true).performScrollToNode(hasTestTag("for-you-$talk4"))
        u1WaitOrDump("talk 4's count") { countRequests().any { talk4 in it } }
        waitForIdle()
        assertNoControls(talk4)
    }

    /**
     * Every result card asks the controller for its own count, and the controller gathers the asks
     * of one moment into one request (web util.tsx requestCount). Drawn on a tall window, so all
     * the cards are composed at once.
     */
    @Test
    fun searchResultsAskForTheirCountsInOneRequest() = runComposeUiTest {
        f.server.seedPerson(f.slug, "Sample · Avery", about = "Placeholder profile 1.", sharedTalkIds = listOf(talk1, talk3, talk4))
        prepare()
        setContent {
            TestDevice(DpSize(390.dp, 4000.dp)) {
                CaddieApp(f.core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Search), people = f.controller)
            }
        }
        u1WaitForTag("search-results")
        for (id in listOf(talk1, talk3, talk4)) waitInCard(hasText(u1CountLabel(1)) and hasAnyAncestor(hasTestTag("talk-people-$id")))
        waitForIdle()
        val asked = countRequests()
        assertEquals(1, asked.size, "one /api/circles/counts request for the page of results, not one per card: $asked")
        assertEquals(setOf(talk1, talk3, talk4), asked.single())
    }

    /**
     * Search, For you and Interested are lazy lists, so a fling composes cards a few at a time. The
     * screens ask for the counts of the whole result set once, so the cards find them in the
     * controller's cache and a long scroll costs no request per window.
     */
    @Test
    fun scrollingThroughAllSearchResultsAsksForCountsInAtMostTwoRequests() = runComposeUiTest {
        // Alpha's talks 1, 3 and 4 (2 is a break, which a search does not list), then the extra ones.
        val ids = (listOf(1, 3, 4) + (5 until 5 + TALKS_IN_LONG_LIST)).map { "alpha-conf-2099:$it" }
        fixture = U1Fixture(crowdedAlpha(TALKS_IN_LONG_LIST, ambient = false), crowdedFakeAlpha(TALKS_IN_LONG_LIST, ambient = false))
        f.server.seedPerson(f.slug, "Sample · Avery", about = "Placeholder profile 1.", sharedTalkIds = listOf(ids.first(), ids[20], ids.last()))
        prepare()
        setContent {
            TestDevice(DpSize(390.dp, 844.dp)) {
                CaddieApp(f.core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Search), people = f.controller)
            }
        }
        u1WaitForTag("search-results")
        // Card by card, by key: each scroll moves one card further. A search by node goes back to
        // the top and pages down again for every card that is not composed yet, so walking 43
        // cards that way does quadratic work, which took over a minute on a busy CI simulator.
        for (id in ids) {
            onNodeWithTag("search-results", useUnmergedTree = true).performScrollToKey(id)
            onNodeWithTag("talk-$id", useUnmergedTree = true).assertExists()
        }
        // The last card has its count, so the controls read what the one request brought.
        waitInCard(hasText(u1CountLabel(1)) and hasAnyAncestor(hasTestTag("talk-people-${ids.last()}")))
        waitForIdle()
        val asked = countRequests()
        assertTrue(asked.isNotEmpty() && asked.size <= 2, "at most two /api/circles/counts requests for ${ids.size} results, not one per window: ${asked.map { it.size }}")
    }

    /** The web (talk.tsx) and the talk sheet show the people controls on every kind of talk; Search's events are kind "ambient". */
    @Test
    fun searchResultsOfEveryKindCarryThePeopleControls() = runComposeUiTest {
        val event = "alpha-conf-2099:5"
        fixture = U1Fixture(crowdedAlpha(0, ambient = true), crowdedFakeAlpha(0, ambient = true))
        f.server.seedPerson(f.slug, "Sample · Avery", about = "Placeholder profile 1.", sharedTalkIds = listOf(event))
        prepare()
        setContent { TestPhone { CaddieApp(f.core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Search), people = f.controller) } }
        u1WaitForTag("search-results")
        onNodeWithText(Strings.Chips.EVENTS).performScrollTo().performClick()
        // The three talks and the event.
        u1WaitForText(Strings.Search.count(4, true, true))
        onNodeWithTag("search-results", useUnmergedTree = true).performScrollToNode(hasTestTag("talk-$event"))
        waitInCard(hasText(u1CountLabel(1)) and hasAnyAncestor(hasTestTag("talk-people-$event")))
    }

    private companion object {
        const val TALKS_IN_LONG_LIST = 40
    }
}

/** The Alpha conference with [extra] more talks (ids 5 on, later in the day, as the bundle lists talks by start) and, with [ambient], one event after them. */
internal fun crowdedAlpha(extra: Int, ambient: Boolean): TestBackend.TestConference {
    val alpha = TestBackend().alpha
    val more = (0 until extra).map { n ->
        TestBackend.TestTalk("${5 + n}", "talk", "Platform session ${5 + n}", "Placeholder abstract.", listOf("Speaker ${5 + n}" to null), "2099-03-03", 940 + n * 10, 950 + n * 10, "Platform", "Hall A")
    }
    val event = if (ambient) listOf(TestBackend.TestTalk("${5 + extra}", "ambient", "Sponsor mixer", "Meet the sponsors.", emptyList(), "2099-03-03", 1400, 1430, "Expo", "Hall A")) else emptyList()
    return TestBackend.TestConference(alpha.slug, alpha.name, alpha.day, alpha.talks + more + event)
}

/** The fake People server's side of [crowdedAlpha]. */
internal fun crowdedFakeAlpha(extra: Int, ambient: Boolean): FakeConference {
    val alpha = FakeConference.alpha()
    val more = (0 until extra).map { n -> FakeTalk("alpha-conf-2099:${5 + n}", "Platform session ${5 + n}") }
    val event = if (ambient) listOf(FakeTalk("alpha-conf-2099:${5 + extra}", "Sponsor mixer", kind = "ambient")) else emptyList()
    return FakeConference(alpha.slug, listOf("Hall A", "Hall B"), alpha.topics, alpha.talks + more + event)
}
