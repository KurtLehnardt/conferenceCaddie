package app.conferencecaddie.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.runComposeUiTest
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.ui.shell.SampleData
import app.conferencecaddie.ui.shell.ShellActions
import app.conferencecaddie.ui.shell.ShellState
import app.conferencecaddie.ui.strings.Strings
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

// The shell's flows, run on the iOS simulator (iosSimulatorArm64Test) and on an Android device or
// emulator (connectedAndroidDeviceTest).
@OptIn(ExperimentalTestApi::class)
class ShellUiTest {
    private val official = "https://conference-caddie.example.org"

    private fun state(peopleEnabled: Boolean = false, selected: String? = SampleData.CONFERENCES.first().id) = ShellState(
        capabilities = Capabilities(people = Capabilities.People(enabled = peopleEnabled)),
        conferences = SampleData.CONFERENCES,
        selectedConferenceId = selected,
        serverBase = official,
        officialServerBase = official,
        appVersion = "test",
    )

    @Test
    fun tabsFollowTheWebOrderAndSwitch() = runComposeUiTest {
        setContent { App(state()) }

        // Without people features there is no People tab, and the app opens on For you.
        onNodeWithTag("tab-People").assertDoesNotExist()
        onNodeWithTag("tab-For you").assertIsSelected()
        onNodeWithTag("tab-body-ForYou").assertExists()

        onNodeWithTag("tab-Search").performClick()
        onNodeWithTag("tab-Search").assertIsSelected()
        onNodeWithTag("tab-body-Search").assertExists()

        onNodeWithTag("tab-Interested").performClick()
        onNodeWithText(Strings.Interested.EMPTY).assertIsDisplayed()
        // "Find talks" on the empty list goes to Search, as on the web.
        onNodeWithText(Strings.Interested.FIND_TALKS).performClick()
        onNodeWithTag("tab-Search").assertIsSelected()
    }

    @Test
    fun peopleTabAppearsOnlyWithPeopleFeatures() = runComposeUiTest {
        var current by mutableStateOf(state(peopleEnabled = true))
        setContent { App(current) }

        onNodeWithTag("tab-People").assertIsSelected()
        onNodeWithTag("tab-body-People").assertExists()

        // The backend turns people features off while People is showing: the tab goes and the
        // shell falls back to the first remaining tab.
        current = state(peopleEnabled = false)
        waitForIdle()
        onNodeWithTag("tab-People").assertDoesNotExist()
        onNodeWithTag("tab-For you").assertIsSelected()
    }

    @Test
    fun conferenceSwitcherPicksAConference() = runComposeUiTest {
        var picked: String? = null
        setContent { App(state(), ShellActions(onSelectConference = { picked = it })) }

        onNodeWithTag("conference-switcher").performClick()
        onNodeWithText(Strings.Switcher.TITLE).assertIsDisplayed()
        onNodeWithText(Strings.Switcher.UNAVAILABLE_HEADING.uppercase()).assertExists()
        onNodeWithText("Sample Dev Day Nairobi").performClick()
        waitForIdle()
        assertEquals("sample-dev-day-nairobi-2026", picked)
    }

    @Test
    fun anUnavailableConferenceShowsTheWebBlocker() = runComposeUiTest {
        setContent { App(state(selected = "sample-open-source-forum-2026")) }
        onNodeWithText(Strings.Blockers.SCHEDULE_NOT_AVAILABLE).assertIsDisplayed()
        onNodeWithText(Strings.Blockers.cantBeSearched("Sample Open Source Forum")).assertExists()
        onNodeWithText(Strings.Blockers.OPEN_OFFICIAL).assertExists()
    }

    @Test
    fun settingsValidatesTheServerAndConfirmsBeforeSwitching() = runComposeUiTest {
        var changed: String? = null
        setContent { App(state(), ShellActions(onChangeServer = { changed = it })) }

        onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
        onNodeWithTag("settings-screen").assertExists()

        // Refused addresses explain themselves and ask nothing.
        onNodeWithTag("server-url").performTextReplacement("not a url")
        onNodeWithTag("server-save").performClick()
        onNodeWithText(Strings.Settings.URL_NOT_A_URL).assertExists()
        onNodeWithTag("server-url").performTextReplacement("http://caddie.example.net")
        onNodeWithTag("server-save").performClick()
        onNodeWithText(Strings.Settings.URL_HTTPS).assertExists()
        onNodeWithTag("connect-confirmation").assertDoesNotExist()

        // A good address is normalised and named exactly in the confirmation; Cancel changes nothing.
        onNodeWithTag("server-url").performTextReplacement("https://Caddie.Example.net:443/demo/")
        onNodeWithTag("server-save").performClick()
        onNodeWithTag("connect-prompt").assertExists()
        onNodeWithText(Strings.Connect.prompt("https://caddie.example.net/demo")).assertIsDisplayed()
        onNodeWithText(Strings.Connect.NOT_OFFICIAL).assertExists()
        onNodeWithText(Strings.Common.CANCEL).performClick()
        onNodeWithTag("connect-confirmation").assertDoesNotExist()
        assertNull(changed)

        // Saving again and confirming switches.
        onNodeWithTag("server-save").performClick()
        onNodeWithText(Strings.Connect.SWITCH).performClick()
        waitForIdle()
        assertEquals("https://caddie.example.net/demo", changed)

        // Back leaves Settings.
        onNodeWithContentDescription(Strings.AppBar.BACK).performClick()
        onNodeWithTag("settings-screen").assertDoesNotExist()
    }

    @Test
    fun aConnectLinkNeedsConfirmationAndCanBeDeclined() = runComposeUiTest {
        var declined = false
        var changed: String? = null
        var current by mutableStateOf(state().copy(pendingConnect = "https://kurtlehnardt.github.io/conferenceCaddie"))
        setContent {
            App(
                current,
                ShellActions(
                    onChangeServer = { changed = it },
                    onDeclineConnect = {
                        declined = true
                        current = current.copy(pendingConnect = null)
                    },
                ),
            )
        }

        onNodeWithText(Strings.Connect.prompt("https://kurtlehnardt.github.io/conferenceCaddie")).assertIsDisplayed()
        onNodeWithText(Strings.Common.CANCEL).performClick()
        waitForIdle()
        assertEquals(true, declined)
        assertNull(changed)
        onNodeWithTag("connect-confirmation").assertDoesNotExist()
    }
}
