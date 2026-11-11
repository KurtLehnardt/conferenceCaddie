package app.conferencecaddie.ui.people

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import app.conferencecaddie.shared.people.Person
import app.conferencecaddie.shared.people.ReportKind
import app.conferencecaddie.ui.shell.rememberShellNavigation
import app.conferencecaddie.ui.talks.Restoration
import app.conferencecaddie.ui.theme.CaddieTheme
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

// What the people UI keeps when the activity is re-created (a rotation, a dark-mode switch): the
// open sheets and the typed text. Saved by ref and small values; people are found again in the
// controller's state.
@OptIn(ExperimentalTestApi::class)
class PeopleRestoreUiTest {
    private val rigs = ArrayList<U3Rig>()
    private val talks = PeopleTalks(bundle = null, interested = emptyList(), nowMs = 0)

    private fun rig(): U3Rig = U3Rig().also { rigs += it }

    @AfterTest
    fun cleanUp() = rigs.forEach { it.close() }

    @Test
    fun spotMeTextSurvivesARecreation() = runComposeUiTest {
        val rig = rig()
        val ada = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            val ada = rig.seedAda("Hallway", located = true, spot = "by the stairs")
            check(rig.controller.turnOnPresence("Expo hall", "") == null)
            ada
        }
        val id = u3Await(rig) { rig.activeMeet(ada) }
        val restoration = Restoration(this)
        restoration.setContent {
            TestPhone {
                CaddieTheme {
                    val state by rig.controller.state.collectAsState()
                    MeetScreen(id, state, rig.host)
                }
            }
        }
        u3WaitForTag("meet-them")
        onNodeWithTag("meet-spot-me").performScrollTo().typeText("green hoodie")
        onNodeWithTag("meet-spot-me").assertTextEquals("green hoodie")

        restoration.emulateSaveAndRestore()

        u3WaitForTag("meet-them")
        onNodeWithTag("meet-spot-me").performScrollTo().assertTextEquals("green hoodie")
    }

    @Test
    fun theReportSheetAndTheBlockConfirmationSurviveARecreation() = runComposeUiTest {
        val rig = rig()
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
        }
        lateinit var host: PeopleHost
        val restoration = Restoration(this)
        restoration.setContent {
            val nav = rememberShellNavigation()
            val ui = rememberPeopleUi(rig.controller, nav, talks, true, true, null, { _, _, _ -> }, {}, {})!!
            host = ui.host
            TestPhone { CaddieTheme { Box(Modifier.fillMaxSize()); ui.Sheets() } }
        }
        val target = ReportTarget("ref-1", "Ada Seed", ReportKind.Spot, "ref-1")
        runOnIdle {
            host.report(target)
            host.markWaved("ref-2")
        }
        u3WaitForTag("report-sheet")

        restoration.emulateSaveAndRestore()

        u3WaitForTag("report-sheet")
        runOnIdle {
            assertEquals(target, host.reporting)
            assertEquals(true, host.hasWaved("ref-2"))
            host.closeReport()
            host.confirmBlock("ref-1", "Ada Seed")
        }
        u3WaitForTag("block-confirm")

        restoration.emulateSaveAndRestore()

        u3WaitForTag("block-confirm")
        runOnIdle {
            assertEquals("ref-1", host.blocking?.ref)
            assertEquals("Ada Seed", host.blocking?.name)
        }
    }

    @Test
    fun theAskSheetComesBackForAPersonTheControllerKnowsAndDropsForOneItDoesNot() = runComposeUiTest {
        val rig = rig()
        val ada = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            val ada = rig.seedAda("Hallway")
            check(rig.controller.turnOnPresence("Expo hall", "") == null)
            rig.controller.setAroundVisible(true)
            ada
        }
        waitUntil(timeoutMillis = 20_000) { rig.state.around.people.any { it.ref == ada.ref } }
        lateinit var host: PeopleHost
        val restoration = Restoration(this)
        restoration.setContent {
            val nav = rememberShellNavigation()
            val ui = rememberPeopleUi(rig.controller, nav, talks, true, true, null, { _, _, _ -> }, {}, {})!!
            host = ui.host
            TestPhone { CaddieTheme { Box(Modifier.fillMaxSize()); ui.Sheets() } }
        }
        runOnIdle { host.ask(Person(ada.ref, ada.displayName)) }
        u3WaitForTag("ask-sheet")

        restoration.emulateSaveAndRestore()

        u3WaitForTag("ask-sheet")
        runOnIdle { assertEquals(ada.ref, host.askingRef) }

        // A person nothing knows any more: the sheet is dropped after the restore.
        runOnIdle {
            host.closeAsk()
            host.ask(Person("gone-ref", "Gone Person"))
        }
        u3WaitForTag("ask-sheet")
        restoration.emulateSaveAndRestore()
        u3WaitForNoTag("ask-sheet")
        waitUntil(timeoutMillis = 20_000) { host.askingRef == null }
        runOnIdle { assertNull(host.asking) }
    }
}
