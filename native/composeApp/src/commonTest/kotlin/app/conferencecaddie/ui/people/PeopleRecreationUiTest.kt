package app.conferencecaddie.ui.people

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import app.conferencecaddie.shared.people.ReportKind
import app.conferencecaddie.ui.shell.PeoplePage
import app.conferencecaddie.ui.shell.ShellNavigation
import app.conferencecaddie.ui.shell.rememberShellNavigation
import app.conferencecaddie.ui.talks.Restoration
import app.conferencecaddie.ui.theme.CaddieTheme
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

// An answer that comes after Android re-created the activity (a rotation, a theme or a locale
// change). The people layer is made as the app makes it (rememberPeopleUi), under a
// ViewModelStoreOwner that outlives the re-creation as the activity's store does; Restoration
// disposes the composition and composes it again from its saved state. Each action is held while
// the re-creation happens, then answered.
//
// The shell's toast is the composition's own: a toast given to a composition that has gone is
// never seen, as on the phone, so each test checks that the answer reaches the new one.
@OptIn(ExperimentalTestApi::class)
class PeopleRecreationUiTest {
    private val rigs = ArrayList<U3Rig>()
    private val talks = PeopleTalks(bundle = null, interested = emptyList(), nowMs = 0)

    private fun rig(): U3Rig = U3Rig().also { rigs += it }

    /** The activity's ViewModelStore, which a re-creation keeps. */
    private val owner = object : ViewModelStoreOwner {
        override val viewModelStore = ViewModelStore()
    }

    @AfterTest
    fun cleanUp() {
        owner.viewModelStore.clear()
        rigs.forEach { it.close() }
    }

    /** A toast as the shell showed it. */
    private class Shown(val message: String, val label: String?, val action: (() -> Unit)?)

    /** The toasts the composition that showed them was still there for. */
    private val toasts = MutableStateFlow<List<Shown>>(emptyList())

    /** The navigation of the composition that shows now. */
    private var navigation: ShellNavigation? = null

    /** Whether a composition is still in the composition. */
    private class Alive {
        @kotlin.concurrent.Volatile
        var value = false
    }

    private fun ComposeUiTest.showPeople(rig: U3Rig, content: @Composable (PeopleUi) -> Unit): Restoration {
        val restoration = Restoration(this)
        restoration.setContent {
            CompositionLocalProvider(LocalViewModelStoreOwner provides owner) {
                val nav = rememberShellNavigation()
                navigation = nav
                // The shell's toast belongs to this composition and is lost with it.
                val alive = remember { Alive() }
                DisposableEffect(alive) {
                    alive.value = true
                    onDispose { alive.value = false }
                }
                val ui = rememberPeopleUi(rig.controller, nav, talks, true, true, null, { message, label, action ->
                    if (alive.value) toasts.update { it + Shown(message, label, action) }
                }, {}, {})!!
                TestPhone { CaddieTheme { content(ui) } }
            }
        }
        return restoration
    }

    private fun ComposeUiTest.waitForToast(message: String): Shown {
        waitUntil(timeoutMillis = 20_000) { toasts.value.any { it.message == message } }
        return toasts.value.first { it.message == message }
    }

    @Composable
    private fun PresenceCard(ui: PeopleUi) {
        val state by ui.host.controller.state.collectAsState()
        PeopleScreenColumn { PresenceControls(state, ui.host) }
    }

    @Test
    fun anExtendAnsweredAfterARecreationIsToasted() = runComposeUiTest {
        val rig = rig()
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            check(rig.controller.turnOnPresence("Hallway", "") == null)
        }
        val restoration = showPeople(rig) { PresenceCard(it) }
        u3WaitForTag("presence-extend")

        val before = rig.calls("PUT", "/api/presence").size
        val held = HeldAction(rig.controller) { rig.calls("PUT", "/api/presence").size > before }
        onNodeWithTag("presence-extend").performClick()
        waitUntil(timeoutMillis = 20_000) { held.hasArrived }
        restoration.emulateSaveAndRestore()
        u3WaitForTag("presence-card")
        held.release()
        waitForToast(ConnectStrings.EXTENDED)
    }

    @Test
    fun aTurnOnAnsweredAfterARecreationClosesTheSetupPanel() = runComposeUiTest {
        val rig = rig()
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
        }
        val restoration = showPeople(rig) { PresenceCard(it) }
        onNode(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL)).performClick()
        u3WaitForTag("presence-setup")

        val hold = rig.server.hold("PUT", "/api/presence")
        onNodeWithText(ConnectStrings.I_AM_AROUND).performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        restoration.emulateSaveAndRestore()
        u3WaitForTag("presence-setup")
        hold.release()
        waitUntil(timeoutMillis = 20_000) { rig.state.presence.on }
        u3WaitForTag("presence-on")
        u3WaitForNoTag("presence-setup")
    }

    @Test
    fun aToastsOpenProfileAfterARecreationOpensItInTheNewComposition() = runComposeUiTest {
        val rig = rig()
        // No visible profile: I'm around answers that the profile must be visible first.
        u3Await(rig) { rig.controller.updateContext(rig.context()) }
        val restoration = showPeople(rig) { PresenceCard(it) }
        onNode(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL)).performClick()
        u3WaitForTag("presence-setup")

        val held = HeldAction(rig.controller) { !rig.state.presence.on }
        onNodeWithText(ConnectStrings.I_AM_AROUND).performClick()
        waitUntil(timeoutMillis = 20_000) { held.hasArrived }
        restoration.emulateSaveAndRestore()
        u3WaitForTag("presence-card")
        held.release()
        // Under the panel while the card that asked showed; that card has gone, so it is a toast,
        // and its "Open profile" moves the screens that show now.
        val shown = waitForToast("Make your profile visible first.")
        assertEquals(PeopleCommonStrings.OPEN_PROFILE, shown.label)
        runOnUiThread { shown.action!!() }
        waitUntil(timeoutMillis = 20_000) { navigation!!.pages == listOf(PeoplePage.Profile) }
    }

    @Test
    fun anAskAnsweredAfterARecreationSaysAskedInTheSheet() = runComposeUiTest {
        val rig = rig()
        val ada = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            val ada = rig.seedAda("Hallway")
            check(rig.controller.turnOnPresence("Hallway", "") == null)
            // Around now knows her, so the sheet open for her comes back after a re-creation.
            rig.controller.setAroundVisible(true)
            ada
        }
        waitUntil(timeoutMillis = 20_000) { rig.state.around.people.any { it.ref == ada.ref } }
        lateinit var host: PeopleHost
        val restoration = showPeople(rig) { ui ->
            host = ui.host
            Box(Modifier.fillMaxSize())
            ui.Sheets()
        }
        runOnIdle { host.ask(rig.person(ada)) }
        u3WaitForTag("ask-send")

        val hold = rig.server.hold("POST", "/api/meet")
        onNodeWithTag("ask-send").performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        restoration.emulateSaveAndRestore()
        u3WaitForTag("ask-sheet")
        hold.release()
        // The sheet the new composition shows says so, as the one that asked would have.
        u3WaitForText(ConnectStrings.ASKED)
        u3WaitForNoTag("ask-send")
    }

    @Test
    fun aFoundViewAnsweredAfterARecreationShowsAndStaysAfterTheNext() = runComposeUiTest {
        val rig = rig()
        val id = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            val ada = rig.seedAda("Hallway")
            check(rig.controller.turnOnPresence("Expo hall", "") == null)
            rig.activeMeet(ada)
        }
        val restoration = showPeople(rig) { ui ->
            val state by ui.host.controller.state.collectAsState()
            MeetScreen(id, state, ui.host)
        }
        u3WaitForTag("meet-found")

        val held = HeldAction(rig.controller) { rig.calls("POST", "/api/meet/$id/found").isNotEmpty() }
        onNodeWithTag("meet-found").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { held.hasArrived }
        restoration.emulateSaveAndRestore()
        held.release()
        // Found, as the Meet up that asked would have shown; read again, the server would say 410.
        u3WaitForTag("meet-found-card")
        onNodeWithText(ConnectStrings.SAVE_PERSON).performClick()
        waitUntil(timeoutMillis = 20_000) { rig.state.met.isNotEmpty() }

        restoration.emulateSaveAndRestore()
        u3WaitForTag("meet-found-card")
        u3WaitForText(ConnectStrings.SAVED_UNDER_SETTINGS)
        onNodeWithText(ConnectStrings.SAVE_PERSON).assertDoesNotExist()
    }

    @Test
    fun aReportSentAcrossARecreationIsToastedAndClosesTheSheet() = runComposeUiTest {
        val rig = rig()
        val ada = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            rig.seedAda("Hallway")
        }
        lateinit var host: PeopleHost
        val restoration = showPeople(rig) { ui ->
            host = ui.host
            Box(Modifier.fillMaxSize())
            ui.Sheets()
        }
        runOnIdle { host.report(ReportTarget(ada.ref, ada.displayName, ReportKind.Profile, ada.ref)) }
        u3WaitForTag("report-sheet")
        onNodeWithTag("report-reason-${PeopleStrings.REPORT_REASONS.first().first.name.lowercase()}").performClick()

        val hold = rig.server.hold("POST", "/api/people/report")
        onNodeWithTag("report-send").performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        restoration.emulateSaveAndRestore()
        u3WaitForTag("report-sheet")
        hold.release()
        waitForToast(PeopleStrings.REPORT_THANKS)
        // The sheet the new composition shows closes too: its memory is the one the answer changed.
        u3WaitForNoTag("report-sheet")
    }
}
