package app.conferencecaddie.ui.shell

import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.ui.App
import app.conferencecaddie.ui.people.RequestsButton
import app.conferencecaddie.ui.strings.Strings
import kotlin.test.Test
import kotlin.test.assertEquals

// The pages over the tabs: Settings, and the people pages Profile, Requests and Meet up, each with
// the web's Back. Run on the iOS simulator and on an Android device or emulator.
@OptIn(ExperimentalTestApi::class)
class PageStackUiTest {
    private fun state(peopleEnabled: Boolean = true, badge: Int = 0, profileName: String = "Jordan Rivera") = ShellState(
        capabilities = Capabilities(people = Capabilities.People(enabled = peopleEnabled)),
        conferences = SampleData.CONFERENCES,
        selectedConferenceId = SampleData.CONFERENCES.first().id,
        serverBase = "https://caddie.test",
        officialServerBase = "https://caddie.test",
        peopleBadge = badge,
        profileName = profileName,
        appVersion = "test",
    )

    /** The people slots, drawn as plain text so only the shell is under test. */
    private fun content(navigation: () -> ShellNavigator, badge: Int = 0, withPeople: Boolean = true) = TabContent(
        people = { Text("People home", Modifier.testTag("people-home")) },
        appBarActions = { tab -> if (tab == Tab.People) RequestsButton(badge, { navigation().openPage(PeoplePage.Inbox) }) },
        peoplePage = if (withPeople) {
            { page -> Text("Body of $page") }
        } else {
            null
        },
        settingsPeople = if (withPeople) {
            { Text("People groups", Modifier.testTag("settings-people")) }
        } else {
            null
        },
    )

    @Test
    fun settingsOpensProfileAndProfilesBackReturnsToSettings() = runComposeUiTest {
        lateinit var nav: ShellNavigation
        setContent {
            nav = rememberShellNavigation()
            App(state(), content = content({ nav }), navigation = nav)
        }

        onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
        onNodeWithTag("settings-screen").assertExists()
        // You comes first, with the profile's name under Profile, then the people groups.
        onNodeWithTag("settings-you").assertExists()
        onNodeWithText("Jordan Rivera").assertExists()
        onNodeWithTag("settings-people").assertExists()

        onNodeWithText(Strings.Settings.PROFILE).performClick()
        onNodeWithTag("page-profile").assertExists()
        onNodeWithTag("settings-screen").assertDoesNotExist()
        onNodeWithText(Strings.AppBar.PROFILE).assertIsDisplayed()
        // Profile selects no tab and has no gear.
        onNodeWithTag("tab-People").assertIsNotSelected()
        onNodeWithContentDescription(Strings.AppBar.SETTINGS).assertDoesNotExist()

        // "‹ Settings" leads back to the Settings underneath.
        onNodeWithContentDescription(Strings.AppBar.BACK_TO_SETTINGS).performClick()
        onNodeWithTag("settings-screen").assertExists()
        onNodeWithTag("page-profile").assertDoesNotExist()
        assertEquals(listOf<ShellPage>(ShellPage.Settings), nav.pages)

        // Settings' Back leads to the tab.
        onNodeWithContentDescription(Strings.AppBar.BACK).performClick()
        onNodeWithTag("settings-screen").assertDoesNotExist()
        onNodeWithTag("people-home").assertExists()
        onNodeWithTag("tab-People").assertIsSelected()

        // Opened from the People tab, Profile's Back still leads to Settings, and the system Back
        // from there returns to Profile, as the browser's Back does on the web.
        runOnIdle { nav.openPage(PeoplePage.Profile) }
        onNodeWithTag("page-profile").assertExists()
        onNodeWithContentDescription(Strings.AppBar.BACK_TO_SETTINGS).performClick()
        onNodeWithTag("settings-screen").assertExists()
        runOnIdle { nav.back() }
        onNodeWithTag("page-profile").assertExists()
    }

    @Test
    fun requestsAndMeetUpKeepPeopleSelectedAndBackLeadsToTheTab() = runComposeUiTest {
        lateinit var nav: ShellNavigation
        setContent {
            nav = rememberShellNavigation()
            App(state(), content = content({ nav }), navigation = nav)
        }

        onNodeWithTag("requests-button").performClick()
        onNodeWithTag("page-inbox").assertExists()
        onNodeWithText(Strings.AppBar.REQUESTS).assertIsDisplayed()
        onNodeWithTag("tab-People").assertIsSelected()
        onNodeWithContentDescription(Strings.AppBar.SETTINGS).assertDoesNotExist()

        runOnIdle { nav.openPage(PeoplePage.Meet("m1")) }
        onNodeWithTag("page-meet").assertExists()
        onNodeWithText(Strings.AppBar.MEET_UP).assertIsDisplayed()
        onNodeWithText("Body of Meet(meetId=m1)").assertExists()
        onNodeWithTag("tab-People").assertIsSelected()

        // The system Back returns to Requests; the app bar's Back goes straight to the tab.
        runOnIdle { nav.back() }
        onNodeWithTag("page-inbox").assertExists()
        runOnIdle { nav.openPage(PeoplePage.Meet("m1")) }
        onNodeWithContentDescription(Strings.AppBar.BACK).performClick()
        onNodeWithTag("page-meet").assertDoesNotExist()
        onNodeWithTag("page-inbox").assertDoesNotExist()
        onNodeWithTag("people-home").assertExists()
        assertEquals(emptyList(), nav.pages)

        // A tab in the tab bar leaves every page.
        runOnIdle { nav.openPage(PeoplePage.Inbox) }
        onNodeWithTag("tab-Search").performClick()
        onNodeWithTag("page-inbox").assertDoesNotExist()
        onNodeWithTag("tab-Search").assertIsSelected()
    }

    @Test
    fun peoplePagesCloseWhenPeopleFeaturesGo() = runComposeUiTest {
        lateinit var nav: ShellNavigation
        var current by mutableStateOf(state())
        setContent {
            nav = rememberShellNavigation()
            App(current, content = content({ nav }), navigation = nav)
        }
        runOnIdle {
            nav.openSettings()
            nav.openPage(PeoplePage.Profile)
        }
        onNodeWithTag("page-profile").assertExists()
        current = state(peopleEnabled = false)
        waitForIdle()
        onNodeWithTag("page-profile").assertDoesNotExist()
        onNodeWithTag("settings-screen").assertExists()
        // Without people features Settings has no You group and no people groups.
        onNodeWithTag("settings-you").assertDoesNotExist()
        onNodeWithTag("settings-people").assertDoesNotExist()
    }

    @Test
    fun settingsHasNoYouGroupWithoutPeoplePages() = runComposeUiTest {
        setContent { App(state(), content = content({ error("unused") }, withPeople = false)) }
        onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
        onNodeWithTag("settings-screen").assertExists()
        onNodeWithTag("settings-you").assertDoesNotExist()
        onNodeWithText(Strings.Settings.SET_UP_PROFILE).assertDoesNotExist()
    }

    @Test
    fun theRequestsButtonAndTheTabCarryTheCount() = runComposeUiTest {
        var badge by mutableStateOf(3)
        setContent {
            val nav = rememberShellNavigation()
            App(state(badge = badge), content = content({ nav }, badge = badge), navigation = nav)
        }
        onNodeWithTag("requests-button").assertContentDescriptionEquals("Requests, 3 new")
        onNodeWithTag("tab-People").assertContentDescriptionEquals("People, 3 new requests")

        badge = 1
        waitForIdle()
        onNodeWithTag("requests-button").assertContentDescriptionEquals("Requests, 1 new")
        onNodeWithTag("tab-People").assertContentDescriptionEquals("People, 1 new request")

        badge = 0
        waitForIdle()
        onNodeWithTag("requests-button").assertContentDescriptionEquals(Strings.AppBar.REQUESTS)
        onNodeWithContentDescription("People, 0 new requests").assertDoesNotExist()
    }

    @Test
    fun aProfileWithoutANameSaysSetUp() = runComposeUiTest {
        setContent {
            val nav = rememberShellNavigation()
            App(state(profileName = ""), content = content({ nav }), navigation = nav)
        }
        onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
        onNodeWithText(Strings.Settings.SET_UP_PROFILE).assertExists()
    }
}
