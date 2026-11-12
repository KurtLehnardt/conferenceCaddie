package app.conferencecaddie.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.click
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.ui.shell.SampleData
import app.conferencecaddie.ui.shell.ShellState
import app.conferencecaddie.ui.shell.Tab
import kotlin.test.Test

// Which tab the shell opens on when the capabilities arrive after the first frame: on a first start
// against a backend with people features (tier 3), the shell used to pick For you before it knew of
// People and kept it. It now follows the backend's first tab until the person picks one. On the iOS
// simulator and an Android emulator.
@OptIn(ExperimentalTestApi::class)
class ShellTabsUiTest {
    private fun state(capabilities: Capabilities) = ShellState(
        capabilities = capabilities,
        conferences = SampleData.CONFERENCES,
        selectedConferenceId = SampleData.CONFERENCES.first().id,
        appVersion = "test",
    )

    private val tier3 = Capabilities(people = Capabilities.People(enabled = true))

    @Test
    fun aFirstStartOpensOnPeopleOnceTheCapabilitiesArrive() = runComposeUiTest {
        // Before the capabilities arrive the app knows no people features.
        var current by mutableStateOf(state(Capabilities.None))
        setContent { App(current) }
        onNodeWithTag("tab-People").assertDoesNotExist()
        onNodeWithTag("tab-For you").assertIsSelected()

        current = state(tier3)
        waitForIdle()
        onNodeWithTag("tab-People").assertIsSelected()
        onNodeWithTag("tab-body-People").assertExists()
    }

    @Test
    fun aTabPickedBeforeTheCapabilitiesArriveStaysPicked() = runComposeUiTest {
        var current by mutableStateOf(state(Capabilities.None))
        setContent { App(current) }
        onNodeWithTag("tab-Search").performClick()
        onNodeWithTag("tab-Search").assertIsSelected()

        current = state(tier3)
        waitForIdle()
        onNodeWithTag("tab-People").assertExists()
        onNodeWithTag("tab-Search").assertIsSelected()
    }

    @Test
    fun aLaunchTabTheBackendDoesNotOfferWaitsForIt() = runComposeUiTest {
        // People asked for (a link or launch option) before the backend is known: the first tab
        // shows meanwhile, and People once it is offered.
        var current by mutableStateOf(state(Capabilities.None))
        setContent { App(current, initialTab = Tab.People) }
        onNodeWithTag("tab-For you").assertIsSelected()
        current = state(tier3)
        waitForIdle()
        onNodeWithTag("tab-People").assertIsSelected()
    }

    @Test
    fun aRequestFromALinkShowsItsTab() = runComposeUiTest {
        var request by mutableStateOf<ShellRequest?>(null)
        setContent { App(state(Capabilities.None), request = request) }
        onNodeWithTag("tab-For you").assertIsSelected()
        request = ShellRequest(id = 1, tab = Tab.Interested)
        waitForIdle()
        onNodeWithTag("tab-Interested").assertIsSelected()
        // The person moves on; the same link again shows its tab again.
        onNodeWithTag("tab-Search").performClick()
        request = ShellRequest(id = 2, tab = Tab.Interested)
        waitForIdle()
        onNodeWithTag("tab-Interested").assertIsSelected()
    }

    /**
     * On a first start the tab bar draws no tab until the capabilities say whether People comes
     * first. A person aims at Search where the bar first shows it, a little left of its middle, and
     * the capabilities may arrive after the first frame: the tap still opens Search. When the tabs
     * were drawn at once, the three tabs became four and that spot was For you.
     */
    @Test
    fun aTapOnSearchStaysOnSearchWhenTheCapabilitiesArriveAfterTheFirstFrame() = runComposeUiTest {
        mainClock.autoAdvance = false
        var current by mutableStateOf(state(Capabilities.None).copy(tabsKnown = false))
        setContent { TestDevice(DpSize(360.dp, 640.dp)) { App(current) } }
        mainClock.advanceTimeByFrame()
        fun searchBounds() = onAllNodesWithTag("tab-Search").fetchSemanticsNodes().firstOrNull()?.boundsInRoot
        // Where Search is first drawn, if it is drawn before the capabilities arrive.
        var aim = searchBounds()
        onNodeWithTag("tabs-pending").assertExists()

        current = state(tier3)
        mainClock.advanceTimeByFrame()
        mainClock.advanceTimeByFrame()
        onNodeWithTag("tabs-known").assertExists()
        if (aim == null) aim = searchBounds()
        val at = aim!!
        onRoot().performTouchInput { click(Offset(at.left + at.width / 4, at.center.y)) }
        mainClock.advanceTimeByFrame()
        onNodeWithTag("tab-Search").assertIsSelected()
        onNodeWithTag("tab-People").assertExists()
    }

    /** A first start whose capabilities do not come shows the tabs it has after [TABS_WAIT_MS]. */
    @Test
    fun theTabsShowAfterAWaitWhenTheCapabilitiesDoNotCome() = runComposeUiTest {
        mainClock.autoAdvance = false
        setContent { App(state(Capabilities.None).copy(tabsKnown = false)) }
        mainClock.advanceTimeByFrame()
        onNodeWithTag("tab-Search").assertDoesNotExist()
        mainClock.advanceTimeBy(TABS_WAIT_MS)
        mainClock.advanceTimeByFrame()
        onNodeWithTag("tab-For you").assertExists()
        onNodeWithTag("tab-Search").assertExists()
        onNodeWithTag("tab-Interested").assertExists()
        onNodeWithTag("tab-People").assertDoesNotExist()
    }
}
