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
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.TestDevice
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.talks.CaddieApp
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
    private val f = U1Fixture()
    private val talk1 = "alpha-conf-2099:1"
    private val talk3 = "alpha-conf-2099:3"
    private val talk4 = "alpha-conf-2099:4"

    @AfterTest
    fun cleanUp() = f.close()

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

    /** The circle-count requests the fake has had so far (copied with a retry, as the controller adds to the log from its own thread). */
    private fun countRequests(): List<Set<String>> {
        while (true) {
            val copy = runCatching { f.server.requests.toList() }.getOrNull() ?: continue
            return copy.filter { it.method == "POST" && it.path == "/api/circles/counts" }
                .map { r -> (r.body!!["talk_ids"] as JsonArray).map { it.jsonPrimitive.content }.toSet() }
        }
    }

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
}
