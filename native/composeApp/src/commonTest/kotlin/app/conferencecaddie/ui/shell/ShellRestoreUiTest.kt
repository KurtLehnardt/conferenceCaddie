package app.conferencecaddie.ui.shell

import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.ui.App
import app.conferencecaddie.ui.people.TestPhone
import app.conferencecaddie.ui.talks.Restoration
import kotlin.test.Test
import kotlin.test.assertEquals

// The people pages after the app's process was restored: Profile, Requests and Meet up stay open
// while the capabilities and the conference are still loading, and close only for what is known.
@OptIn(ExperimentalTestApi::class)
class ShellRestoreUiTest {
    private val first = SampleData.CONFERENCES.first().id
    private val second = SampleData.CONFERENCES[1].id

    private fun state(peopleEnabled: Boolean, known: Boolean, conference: String?) = ShellState(
        capabilities = Capabilities(people = Capabilities.People(enabled = peopleEnabled)),
        conferences = SampleData.CONFERENCES,
        selectedConferenceId = conference,
        serverBase = "https://caddie.test",
        officialServerBase = "https://caddie.test",
        tabsKnown = known,
        appVersion = "test",
    )

    private val content = TabContent(
        people = { Text("People home", Modifier.testTag("people-home")) },
        peoplePage = { page -> Text("Body of $page") },
    )

    // A shell whose capabilities or conference are still loading draws its blocker instead of the
    // page, so what stays open after a restore is read from the stack of pages.
    private fun androidx.compose.ui.test.ComposeUiTest.assertPages(nav: ShellNavigation, expected: List<ShellPage>) =
        runOnIdle { assertEquals(expected, nav.pages) }

    @Test
    fun aRestoredMeetStaysWhileLoadingAndClosesOnARealConferenceSwitch() = runComposeUiTest {
        var shell by mutableStateOf(state(peopleEnabled = true, known = true, conference = first))
        lateinit var nav: ShellNavigation
        val restoration = Restoration(this)
        restoration.setContent {
            nav = rememberShellNavigation()
            TestPhone { App(shell, content = content, navigation = nav) }
        }
        runOnIdle { nav.openPage(PeoplePage.Meet("m1")) }
        onNodeWithTag("page-meet").assertExists()

        // The process is restored: capabilities still loading (features read as off), no conference.
        shell = state(peopleEnabled = false, known = false, conference = null)
        restoration.emulateSaveAndRestore()
        waitForIdle()
        assertPages(nav, listOf<ShellPage>(PeoplePage.Meet("m1")))

        // Capabilities arrive; the conference is still not selected.
        shell = state(peopleEnabled = true, known = true, conference = null)
        waitForIdle()
        assertPages(nav, listOf<ShellPage>(PeoplePage.Meet("m1")))

        // The same conference as before the restore is selected: the meet is still its own.
        shell = state(peopleEnabled = true, known = true, conference = first)
        waitForIdle()
        assertPages(nav, listOf<ShellPage>(PeoplePage.Meet("m1")))

        // A real switch to another conference closes it.
        shell = state(peopleEnabled = true, known = true, conference = second)
        waitForIdle()
        assertPages(nav, emptyList())
    }

    @Test
    fun aRestoredRequestsStayWhileLoadingAndCloseWhenPeopleAreKnownOff() = runComposeUiTest {
        var shell by mutableStateOf(state(peopleEnabled = true, known = true, conference = first))
        lateinit var nav: ShellNavigation
        val restoration = Restoration(this)
        restoration.setContent {
            nav = rememberShellNavigation()
            TestPhone { App(shell, content = content, navigation = nav) }
        }
        runOnIdle { nav.openPage(PeoplePage.Inbox) }
        onNodeWithTag("page-inbox").assertExists()

        shell = state(peopleEnabled = false, known = false, conference = null)
        restoration.emulateSaveAndRestore()
        waitForIdle()
        assertPages(nav, listOf<ShellPage>(PeoplePage.Inbox))

        // The backend answers that it serves no people features: now the pages close.
        shell = state(peopleEnabled = false, known = true, conference = first)
        waitForIdle()
        assertPages(nav, emptyList())
    }
}
