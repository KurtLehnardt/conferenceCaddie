package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import app.conferencecaddie.ui.components.AppBarLabeledBack
import app.conferencecaddie.ui.theme.CaddieTheme
import app.conferencecaddie.ui.theme.PlatformTouchTarget
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Touch targets of at least the platform's minimum (48 dp on Android, 44 pt on iOS) on the
// controls the review found short, the stable people slots, and the presence link that only offers.
@OptIn(ExperimentalTestApi::class)
class PeopleTouchAndHereUiTest {
    private val rigs = ArrayList<U3Rig>()

    private fun rig(): U3Rig = U3Rig().also { rigs += it }

    @AfterTest
    fun cleanUp() = rigs.forEach { it.close() }

    private fun SemanticsNodeInteraction.assertTouchTarget() {
        val b = getUnclippedBoundsInRoot()
        // A tolerance for the rounding of dp to whole pixels at the simulator's density.
        val min: Dp = PlatformTouchTarget - 0.1.dp
        assertTrue(b.height >= min, "height ${b.height} is under $min")
        assertTrue(b.width >= min, "width ${b.width} is under $min")
    }

    @Test
    fun theSettingsBackHasAFullTouchTarget() = runComposeUiTest {
        setContent { TestPhone { CaddieTheme { AppBarLabeledBack("Settings", "Back to Settings", {}) } } }
        onNodeWithTag("appbar-back").assertTouchTarget()
    }

    @Test
    fun theSpotReportHasAFullTouchTarget() = runComposeUiTest {
        val rig = rig()
        val ada = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            val ada = rig.seedAda("Hallway", located = true, spot = "by the stairs")
            check(rig.controller.turnOnPresence("Expo hall", "") == null)
            ada
        }
        val id = u3Await(rig) { rig.activeMeet(ada) }
        u3Show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-them")
        onNodeWithTag("meet-spot-report").performScrollTo().assertTouchTarget()
    }

    @Test
    fun theStillInChipHasAFullTouchTarget() = runComposeUiTest {
        val rig = rig()
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            check(rig.controller.turnOnPresence("Hallway", "", app.conferencecaddie.shared.people.PresenceMode.Day) == null)
        }
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        rig.controller.setForeground(false)
        rig.clock.advance(11 * 60_000L)
        rig.controller.setForeground(true)
        waitUntil(timeoutMillis = 20_000) { rig.state.presence.confirmPending }
        u3WaitForTag("still-here")
        onNodeWithText(ConnectStrings.YES).assertTouchTarget()
        onNodeWithText("Registration").assertTouchTarget()
        onNodeWithText(ConnectStrings.OTHER_ZONE).assertTouchTarget()
    }

    @Test
    fun aHereZoneRequestOnlyOffersPresenceUntilThePersonTaps() = runComposeUiTest {
        val rig = rig()
        // The notice was seen before, which is what used to let a link turn presence on at once.
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            check(rig.controller.turnOnPresence("Hallway", "") == null)
            rig.controller.turnOffPresence()
        }
        val puts = rig.calls("PUT", "/api/presence").size
        val talks = PeopleTalks(bundle = null, interested = emptyList(), nowMs = 0)
        val request = PeopleRequest(hereZone = "Expo hall")
        u3Show(rig) { state -> PeopleScreen(state, rig.host, talks, request) }

        // The setup opens with the zone chosen; nothing was written.
        u3WaitForTag("presence-setup")
        waitForIdle()
        assertEquals(puts, rig.calls("PUT", "/api/presence").size)
        assertTrue(!rig.state.presence.on)

        // Only the person's tap writes it.
        onNodeWithText(ConnectStrings.I_AM_AROUND).performClick()
        waitUntil(timeoutMillis = 20_000) { rig.state.presence.on }
        assertEquals(puts + 1, rig.calls("PUT", "/api/presence").size)
        assertEquals("Expo hall", rig.state.presence.zone)
    }

    @Test
    fun anUnknownHereZoneOffersNothingAndWritesNothing() = runComposeUiTest {
        val rig = rig()
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
        }
        val puts = rig.calls("PUT", "/api/presence").size
        val talks = PeopleTalks(bundle = null, interested = emptyList(), nowMs = 0)
        val request = PeopleRequest(hereZone = "Not A Zone")
        u3Show(rig) { state -> PeopleScreen(state, rig.host, talks, request) }
        u3WaitForTag("presence-setup")
        u3WaitForText(ConnectStrings.UNKNOWN_ZONE, substring = true)
        waitForIdle()
        assertEquals(puts, rig.calls("PUT", "/api/presence").size)
        assertTrue(!rig.state.presence.on)
    }
}
