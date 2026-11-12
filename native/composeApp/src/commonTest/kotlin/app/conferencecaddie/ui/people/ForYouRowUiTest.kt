package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.bundle.TalkTime
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.talks.CaddieApp
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

// The For you row of the People home (web ForYouRow in ForYou.tsx): the device's first suggestions
// as small cards that open the talk, "See all" to the For you tab, the topic prompt when there is
// nothing to suggest from, and no row while a people search shows. The app is CaddieApp on
// TestBackend with a real controller over the in-memory People API. Run on the iOS simulator and on
// Android.
@OptIn(ExperimentalTestApi::class)
class ForYouRowUiTest {
    private val f = U1Fixture()
    private val talk1 = "alpha-conf-2099:1"
    private val talk3 = "alpha-conf-2099:3"
    private val talk4 = "alpha-conf-2099:4"

    @AfterTest
    fun cleanUp() = f.close()

    /** People ready with a named profile, [learn] as the topics For you suggests from, and the People tab open. */
    private fun ComposeUiTest.showPeople(learn: List<String>) {
        u1WaitReady(f)
        f.act { f.controller.updateProfile { it.copy(displayName = "Jordan Rivera", about = "Platform engineer.") } }
        if (learn.isNotEmpty()) f.core.setLearnTopics(learn)
        u1WaitOrDump("the learn topics") { f.core.state.value.learn.topics == learn && f.controller.state.value.profile.displayName == "Jordan Rivera" }
        setContent { TestPhone { CaddieApp(f.core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.People), people = f.controller) } }
        u1WaitForTag("people-screen")
        scrollToRow()
    }

    /** The row is last on the home, so the list composes it only once scrolled to. */
    private fun ComposeUiTest.scrollToRow() {
        u1WaitOrDump("the For you row") { runCatching { onNodeWithTag("people-screen").performScrollToNode(hasTestTag("for-you-row")) }.isSuccess }
    }

    @Test
    fun theRowShowsTheFirstSuggestionsAndOpensThem() = runComposeUiTest {
        showPeople(learn = listOf("kubernetes"))
        val inRow = hasAnyAncestor(hasTestTag("for-you-row"))
        u1WaitForTag("for-you-mini-$talk3")
        onNode(hasText(Strings.ForYou.ROW_TITLE) and inRow).assertIsDisplayed()
        // Both Kubernetes talks, in time order, each with its day and time and why it was picked.
        val bundle = f.bundle!!
        for (id in listOf(talk3, talk4)) {
            val t = bundle.talksById.getValue(id)
            val card = hasAnyAncestor(hasTestTag("for-you-mini-$id"))
            onNode(hasText(t.title) and card, useUnmergedTree = true).assertExists()
            onNode(hasText("${TalkTime.day(t.day)} · ${TalkTime.time(t.startMinutes)}") and card, useUnmergedTree = true).assertExists()
            onNode(hasText(Strings.ForYou.rowWhy(listOf("Kubernetes"))) and card, useUnmergedTree = true).assertExists()
        }
        // The eBPF talk matches nothing asked for.
        onNodeWithTag("for-you-mini-$talk1").assertDoesNotExist()
        onNode(hasTestTag("for-you-mini-$talk3") and hasAnyAncestor(hasTestTag("for-you-row-cards"))).assertExists()

        // A card opens its talk in the sheet.
        onNodeWithTag("for-you-mini-$talk3").performClick()
        u1WaitForTag("talk-sheet")
        onNode(hasText(bundle.talksById.getValue(talk3).title) and hasAnyAncestor(hasTestTag("talk-sheet"))).assertExists()
    }

    @Test
    fun seeAllOpensTheForYouTab() = runComposeUiTest {
        showPeople(learn = listOf("kubernetes"))
        u1WaitForTag("for-you-mini-$talk3")
        onNodeWithTag("for-you-see-all").performScrollTo().assertIsDisplayed().performClick()
        u1WaitForTag("for-you-screen")
        u1WaitForTag("for-you-$talk3")
        onNodeWithTag("people-screen").assertDoesNotExist()
    }

    @Test
    fun withNothingToGoOnTheRowAsksForTopics() = runComposeUiTest {
        showPeople(learn = emptyList())
        u1WaitForNode(hasTestTag("for-you-prompt") and hasAnyAncestor(hasTestTag("for-you-row")))
        onNodeWithText(Strings.ForYou.PICK_TITLE).assertExists()
        // No suggestions, so nothing to see all of.
        onNodeWithTag("for-you-see-all").assertDoesNotExist()
        onNodeWithTag("for-you-prompt-pick").performScrollTo().performClick()
        u1WaitForTag("topic-sheet")
    }

    @Test
    fun aPeopleSearchHidesTheRow() = runComposeUiTest {
        showPeople(learn = listOf("kubernetes"))
        u1WaitForTag("for-you-mini-$talk3")
        onNodeWithTag("people-screen").performScrollToNode(hasTestTag("people-search-field"))
        onNodeWithTag("people-search-field").typeText("kubernetes")
        u1WaitForText(PeopleStrings.PEOPLE_WHO_MATCH)
        u1WaitGone(hasTestTag("for-you-row"))
        // Clearing the search brings it back.
        onNodeWithTag("people-search-field").typeText("")
        u1WaitForText(PeopleStrings.PEOPLE_TO_MEET)
        scrollToRow()
        u1WaitForTag("for-you-mini-$talk3")
        assertEquals(listOf("kubernetes"), f.core.state.value.learn.topics)
    }
}
