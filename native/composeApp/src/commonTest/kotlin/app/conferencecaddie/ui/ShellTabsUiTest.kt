package app.conferencecaddie.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
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
}
