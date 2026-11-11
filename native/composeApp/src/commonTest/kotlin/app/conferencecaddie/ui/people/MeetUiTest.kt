package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import app.conferencecaddie.shared.GeoFix
import app.conferencecaddie.shared.people.ApiResult
import app.conferencecaddie.shared.people.ReportKind
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.shell.Tab
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Meet up against the fake server: an accepted ask with their zone, spot line and the distance,
// my spot-me line and the meeting point, Report, We found each other and Save; the ends the other
// side brings about; Cancel with its confirmation; and a meet that is over.
@OptIn(ExperimentalTestApi::class)
class MeetUiTest {
    private val rigs = ArrayList<U3Rig>()

    private fun rig(): U3Rig = U3Rig().also { rigs += it }

    @AfterTest
    fun cleanUp() = rigs.forEach { it.close() }

    /** Me visible and around in [myZone] (with my position when [located]); Ada around in the Hallway by the stairs. */
    private fun androidx.compose.ui.test.ComposeUiTest.setUp(rig: U3Rig, myZone: String = "Expo hall", located: Boolean = false): FakePerson {
        val ada = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            val ada = rig.seedAda("Hallway", located = true, spot = "by the stairs")
            check(rig.controller.turnOnPresence(myZone, "") == null)
            if (located) rig.locateMe()
            ada
        }
        if (located) {
            waitUntil(timeoutMillis = 20_000) {
                rig.location.emit(GeoFix(MY_LAT, MY_LON, 10.0, rig.clock.ms))
                rig.calls("PUT", "/api/presence").any { it.body!!["location"] != null }
            }
        }
        return ada
    }

    @Test
    fun anAcceptedAskShowsWhereTheyAreHowFarAndEndsFound() = runComposeUiTest {
        val rig = rig()
        val ada = setUp(rig, located = true)
        val id = u3Await(rig) { rig.activeMeet(ada) }
        u3Show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-them")

        // Their zone and spot line, how long is left, and the distance under the cards.
        onNodeWithText("Ada Seed").assertIsDisplayed()
        onNodeWithText("Hallway · by the stairs").assertIsDisplayed()
        onNodeWithText(ConnectStrings.NOT_SAID_SPOT).assertIsDisplayed()
        onNodeWithText(ConnectStrings.minutesLeft(20)).assertIsDisplayed()
        onNodeWithText(ConnectStrings.NO_MEETING_POINT).assertIsDisplayed()
        onNodeWithTag("meet-distance").performScrollTo().assertIsDisplayed()
        onNodeWithText(ConnectStrings.distance(100)).assertIsDisplayed()
        onNodeWithText(ConnectStrings.CAVEAT).performScrollTo().assertIsDisplayed()

        // Report: the spot line, and the meet-up from the menu.
        onNodeWithTag("meet-spot-report").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { rig.host.reporting != null }
        assertEquals(ReportTarget(ada.ref, "Ada Seed", ReportKind.Spot, ada.ref), rig.host.reporting)
        runOnIdle { rig.host.closeReport() }
        onNodeWithContentDescription(PeopleCommonStrings.optionsFor("Ada Seed")).performScrollTo().performClick()
        onNode(hasText(PeopleCommonStrings.REPORT) and hasAnyAncestor(hasTestTag("overflow-menu"))).performClick()
        waitUntil(timeoutMillis = 20_000) { rig.host.reporting != null }
        assertEquals(ReportTarget(ada.ref, "Ada Seed", ReportKind.Meet, id), rig.host.reporting)
        runOnIdle { rig.host.closeReport() }

        // My spot-me line.
        onNodeWithTag("meet-spot-me").performScrollTo().performTextInput("green hoodie")
        onNodeWithText(ConnectStrings.spotMeCount(12)).assertIsDisplayed()
        onNodeWithTag("meet-spot-me-save").performClick()
        u3WaitForText(ConnectStrings.SAVED)
        onNodeWithTag("meet-spot-me-save").assertIsNotEnabled()
        assertEquals(buildJsonObject { put("spot_me", "green hoodie") }, rig.calls("PUT", "/api/meet/$id/details").single().body)

        // The meeting point: their zone is the default.
        onNodeWithText(ConnectStrings.SET_MEETING_POINT).performScrollTo().performClick()
        onNodeWithTag("meet-rendezvous-set").performClick()
        u3WaitForText(ConnectStrings.meetAt("Hallway"))
        assertEquals(buildJsonObject { put("rendezvous", "Hallway") }, rig.calls("PUT", "/api/meet/$id/details").last().body)
        onNodeWithText(ConnectStrings.CHANGE_MEETING_POINT).assertIsDisplayed()

        // We found each other, then Save this person.
        onNodeWithTag("meet-found").performScrollTo().performClick()
        u3WaitForTag("meet-found-card")
        onNodeWithText(ConnectStrings.youFound("Ada Seed")).assertIsDisplayed()
        assertEquals("found", u3Await(rig) { rig.locked { meetState(id) } })
        onNodeWithText(ConnectStrings.SAVE_PERSON).performClick()
        u3WaitForToast(rig, ConnectStrings.SAVED_TOAST)
        u3WaitForText(ConnectStrings.SAVED_UNDER_SETTINGS)
        waitUntil(timeoutMillis = 20_000) { rig.state.met.any { it.displayName == "Ada Seed" && it.about == "Platform engineer." } }
        onNodeWithText(ConnectStrings.BACK_TO_PEOPLE).performClick()
        waitUntil(timeoutMillis = 20_000) { rig.nav.tab == Tab.People }
    }

    @Test
    fun sameZoneSaysSoAndPutsTheMeetingPointLast() = runComposeUiTest {
        val rig = rig()
        val ada = setUp(rig, myZone = "Hallway")
        val id = u3Await(rig) { rig.activeMeet(ada) }
        u3Show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-them")
        onNodeWithText(ConnectStrings.bothIn("Hallway")).assertIsDisplayed()
        // The server set the meeting point to the shared zone on accept.
        onNodeWithText(ConnectStrings.meetAt("Hallway")).performScrollTo().assertIsDisplayed()
        onNodeWithText(ConnectStrings.addALine("Ada Seed")).performScrollTo().assertIsDisplayed()
        onNodeWithTag("meet-distance").assertDoesNotExist()
        val them = onNodeWithTag("meet-them").fetchSemanticsNode().boundsInRoot.top
        val rendezvous = onNodeWithTag("meet-rendezvous").fetchSemanticsNode().boundsInRoot.top
        assertTrue(them < rendezvous)
    }

    @Test
    fun cancelAsksFirst() = runComposeUiTest {
        val rig = rig()
        val ada = setUp(rig)
        val id = u3Await(rig) { rig.activeMeet(ada) }
        u3Show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-cancel")

        // Kept: the dialog's own Cancel.
        onNodeWithTag("meet-cancel").performScrollTo().performClick()
        u3WaitForTag("meet-cancel-confirm")
        onNodeWithText(ConnectStrings.CANCEL_MEET_TITLE).assertIsDisplayed()
        onNodeWithText(ConnectStrings.CANCEL_MEET_BODY).assertIsDisplayed()
        onNode(hasText(Strings.Common.CANCEL) and hasAnyAncestor(hasTestTag("meet-cancel-confirm"))).performClick()
        u3WaitForNoTag("meet-cancel-confirm")
        onNodeWithTag("meet-them").assertExists()
        assertEquals("active", u3Await(rig) { rig.locked { meetState(id) } })

        // Confirmed.
        onNodeWithTag("meet-cancel").performScrollTo().performClick()
        u3WaitForTag("meet-cancel-confirm")
        onNodeWithText(ConnectStrings.CANCEL_MEET_CONFIRM).performClick()
        u3WaitForText(ConnectStrings.MEET_CANCELLED)
        onNodeWithText(ConnectStrings.BACK_TO_PEOPLE).assertIsDisplayed()
        assertEquals("cancelled", u3Await(rig) { rig.locked { meetState(id) } })
    }

    @Test
    fun theirCancelOrFoundEndsTheScreenAtTheNextRead() = runComposeUiTest {
        val rig = rig()
        val ada = setUp(rig)
        val first = u3Await(rig) { rig.activeMeet(ada) }
        u3Show(rig) { state -> MeetScreen(first, state, rig.host) }
        u3WaitForTag("meet-them")
        u3Await(rig) { rig.locked { ada.cancel(first) } }
        mainClock.advanceTimeBy(15_000)
        u3WaitForText(ConnectStrings.cancelledBy("Ada Seed"))
        onNodeWithTag("meet-ended").assertIsDisplayed()
    }

    @Test
    fun theirFoundShowsFoundHereToo() = runComposeUiTest {
        val rig = rig()
        val ada = setUp(rig)
        val id = u3Await(rig) { rig.activeMeet(ada) }
        u3Show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-them")
        u3Await(rig) { rig.locked { ada.found(id) } }
        mainClock.advanceTimeBy(15_000)
        u3WaitForTag("meet-found-card")
        onNodeWithText(ConnectStrings.youFound("Ada Seed")).assertIsDisplayed()
    }

    @Test
    fun aMeetThatRanOutIsOver() = runComposeUiTest {
        val rig = rig()
        val ada = setUp(rig)
        val id = u3Await(rig) { (rig.controller.ask(rig.person(ada), "Hi") as ApiResult.Ok).value.meetId }
        rig.clock.advance(16 * 60_000L)
        u3Show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-ended")
        onNodeWithText(ConnectStrings.MEET_OVER).assertIsDisplayed()
        onNodeWithText(ConnectStrings.BACK_TO_PEOPLE).performClick()
        waitUntil(timeoutMillis = 20_000) { rig.nav.tab == Tab.People }
    }

    @Test
    fun aMeetThatDoesNotExistCannotBeFound() = runComposeUiTest {
        val rig = rig()
        setUp(rig)
        u3Show(rig) { state -> MeetScreen("doesnotexist", state, rig.host) }
        u3WaitForTag("meet-ended")
        onNodeWithText(ConnectStrings.MEET_NOT_FOUND).assertIsDisplayed()
    }
}
