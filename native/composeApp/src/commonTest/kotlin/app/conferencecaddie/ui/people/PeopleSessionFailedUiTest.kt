package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleKeyValue
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.ui.App
import app.conferencecaddie.ui.shell.SampleData
import app.conferencecaddie.ui.shell.ShellState
import app.conferencecaddie.ui.shell.TabContent
import app.conferencecaddie.ui.shell.rememberShellNavigation
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

// A backend whose people records cannot be opened still gets its tabs, and the People tab offers
// "Try again" until the records open. Run on the iOS simulator and on Android.
@OptIn(ExperimentalTestApi::class)
class PeopleSessionFailedUiTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val talks = PeopleTalks(bundle = null, interested = emptyList(), nowMs = 0)

    @AfterTest
    fun cleanUp() {
        scope.cancel()
    }

    /** Records that fail to read while [failing], as a locked Keychain or a disk error does. */
    private class FlakyKeyValue : PeopleKeyValue {
        private val inner = MemoryKeyValue()

        @kotlin.concurrent.Volatile
        var failing = true

        override suspend fun get(key: String): String? = if (failing) error("records unreadable") else inner.get(key)

        override suspend fun set(key: String, value: String?) = inner.set(key, value)
    }

    private fun shellState() = ShellState(
        capabilities = Capabilities(people = Capabilities.People(enabled = true)),
        conferences = SampleData.CONFERENCES,
        selectedConferenceId = SampleData.CONFERENCES.first().id,
        serverBase = TEST_BASE,
        officialServerBase = TEST_BASE,
        online = true,
        appVersion = "test",
    )

    @Test
    fun theTabShowsTryAgainWhileTheRecordsCannotBeOpenedAndTheNormalTabAfterwards() = runComposeUiTest {
        val kv = FlakyKeyValue()
        val controller = PeopleController(kv, emptyPeopleApi, PeopleServices(secureStore = InMemorySecureStore()), scope, allowLocalHttp = false)
        scope.launch { controller.updateContext(peopleContext()) }
        setContent {
            val nav = rememberShellNavigation()
            val ui = rememberPeopleUi(controller, nav, talks, true, true, null, { _, _, _ -> }, {}, {}, null)!!
            val content = TabContent(people = ui.tab, appBarActions = ui.appBarActions, peoplePage = ui.page, settingsPeople = ui.settings)
            TestPhone { App(ui.shellState(shellState()), content = content, navigation = nav) }
        }
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag("people-session-failed")).fetchSemanticsNodes().isNotEmpty() }
        onNodeWithTag("tab-People").assertIsSelected()
        onNodeWithTag("people-session-failed").assertIsDisplayed()

        // Still failing: Try again leaves the message up.
        onNodeWithTag("people-session-retry").performClick()
        waitForIdle()
        onNodeWithTag("people-session-failed").assertIsDisplayed()

        kv.failing = false
        onNodeWithTag("people-session-retry").performClick()
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag("people-home")).fetchSemanticsNodes().isNotEmpty() }
        onNodeWithTag("people-session-failed").assertDoesNotExist()
    }
}
