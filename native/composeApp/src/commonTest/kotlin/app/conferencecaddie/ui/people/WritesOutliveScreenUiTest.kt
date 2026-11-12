package app.conferencecaddie.ui.people

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.click
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.talks.CaddieApp
import app.conferencecaddie.ui.talks.TalkLaunch
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonPrimitive

// What a person does is not undone by leaving the screen. A write the controller has been asked
// for (presence, being visible, sharing for a talk) goes on when the screen that asked is closed
// before the server answers, so the phone and the server end in the same state. Each test holds the
// fake server's answer, leaves the screen (a tab, Back or the talk sheet's Close) so that the
// screen's own coroutine scope is cancelled, releases the answer and comes back to a screen that
// shows what the server stored. If the controller ran a write in its caller's scope, leaving would
// cancel the request while it is held: the server would never apply it and the waits for the
// server's copy below would time out. The app is CaddieApp on TestBackend with a real controller
// over the in-memory People API. Run on the iOS simulator and on Android.
@OptIn(ExperimentalTestApi::class)
class WritesOutliveScreenUiTest {
    private val f = U1Fixture()
    private val talk1 = "alpha-conf-2099:1"

    @AfterTest
    fun cleanUp() = f.close()

    /** People ready and a named profile on this device, visible to nobody yet; [interested] marked. */
    private fun ComposeUiTest.prepare(vararg interested: String) {
        u1WaitReady(f)
        f.act { f.controller.updateProfile { it.copy(displayName = "Jordan Rivera", about = "Platform engineer.") } }
        interested.forEach { f.core.setInterested(it, true) }
        u1WaitOrDump("the profile and the Interested list") {
            f.core.state.value.interested.containsAll(interested.toList()) && f.controller.state.value.profile.displayName == "Jordan Rivera"
        }
    }

    private fun ComposeUiTest.showApp(launch: DebugLaunch = DebugLaunch(tab = Tab.People), talkLaunch: TalkLaunch = TalkLaunch()) {
        setContent { TestPhone { CaddieApp(f.core, isDebugBuild = false, appVersion = "test", launch = launch, talkLaunch = talkLaunch, people = f.controller) } }
    }

    private fun ComposeUiTest.waitForHeld(hold: FakePeopleServer.Hold) {
        u1WaitOrDump("the request to reach the server") { hold.hasArrived }
    }

    private fun serverMe() = f.server.me(f.slug)

    private fun ComposeUiTest.tab(name: String) {
        u1WaitForTag("tab-$name").performClick()
    }

    private val presenceSwitch = isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL)

    @Test
    fun presenceTurnedOnThenLeavingTheTabIsOnWhenYouComeBackAndTheSwitchTurnsItOff() = runComposeUiTest {
        prepare()
        f.act { assertNull(f.controller.setOpenToMeet(true)) }
        showApp()
        u1WaitForNode(presenceSwitch).performScrollTo().performClick()
        u1WaitForTag("presence-setup")
        val hold = f.server.hold("PUT", "/api/presence")
        onNodeWithText(ConnectStrings.I_AM_AROUND).performScrollTo().performClick()
        waitForHeld(hold)
        assertNull(serverMe()!!.zone, "the server has not applied the presence yet")

        // Leave the People tab while the request is out: the presence card and its scope are gone.
        tab("Search")
        u1WaitGone(hasTestTag("presence-card"))
        hold.release()
        u1WaitOrDump("the server to store the presence") { serverMe()?.zone != null }
        u1WaitOrDump("the controller to show presence on") { f.controller.state.value.presence.on }
        val zone = serverMe()!!.zone!!
        assertEquals(zone, f.controller.state.value.presence.zone)
        assertEquals(1, f.server.requests("PUT", "/api/presence").size)

        // Back on People: the card shows presence on, in the zone the server stored.
        tab("People")
        u1WaitForTag("presence-on")
        u1WaitForText(zone, substring = true)
        onNode(presenceSwitch).assertIsOn()

        // The switch turns it off, on the phone and on the server.
        onNode(presenceSwitch).performScrollTo().performClick()
        u1WaitOrDump("presence off on the server") { serverMe()?.zone == null }
        assertEquals(1, f.server.requests("DELETE", "/api/presence").size)
        u1WaitGone(hasTestTag("presence-on"))
        assertTrue(!f.controller.state.value.presence.on)
        onNode(presenceSwitch).assertIsOff()
    }

    @Test
    fun visibilityTurnedOnThenLeavingProfileIsVisibleWhenYouComeBack() = runComposeUiTest {
        prepare()
        showApp()
        val visibleLabel = ProfileStrings.visibleAt("Alpha Conference")
        val visibleSwitch = isToggleable() and hasText(visibleLabel)
        openProfile()
        val hold = f.server.hold("PUT", "/api/people/profile")
        onNodeWithText(visibleLabel).performScrollTo().performClick()
        waitForHeld(hold)
        assertTrue(serverMe() == null, "the server has no profile yet")

        // Back out of Profile while the save is out.
        onNodeWithContentDescription(Strings.AppBar.BACK_TO_SETTINGS).performClick()
        u1WaitForTag("settings-screen")
        u1WaitGone(hasTestTag("profile-screen"))
        hold.release()
        u1WaitOrDump("the server to store the profile") { serverMe()?.openToMeet == true }
        u1WaitOrDump("the controller to show visible") { f.controller.state.value.visibility.openToMeet }

        // Profile again: the switch shows what the server stored.
        openProfile(fromTabs = false)
        u1WaitForNode(visibleSwitch).performScrollTo().assertIsOn()
        assertEquals(1, f.server.requests("PUT", "/api/people/profile").size)

        // The switch turns it off again on the server too: a profile nobody sees and shared for nothing is removed.
        onNode(visibleSwitch).performClick()
        u1WaitOrDump("the profile to be hidden on the server") { serverMe()?.openToMeet != true }
        u1WaitOrDump("the controller to show hidden") { !f.controller.state.value.visibility.openToMeet }
        onNode(visibleSwitch).assertIsOff()
    }

    @Test
    fun sharingForATalkThenClosingTheSheetShowsTheShareWhenYouOpenItAgain() = runComposeUiTest {
        f.server.seedPerson(f.slug, "Sample · Avery", about = "Placeholder profile 1.", sharedTalkIds = listOf(talk1))
        prepare(talk1)
        // The sharing notice has been seen, so the switch shares at once.
        f.act { f.controller.markShareNoticeSeen() }
        showApp(talkLaunch = TalkLaunch(talk = talk1))
        u1WaitForTag("talk-sheet")
        val controls = hasAnyAncestor(hasTestTag("talk-people-$talk1"))
        u1WaitForNode(hasText(u1CountLabel(1)) and controls)
        val hold = f.server.hold("PUT", "/api/people/profile")
        onNodeWithText(ProfileStrings.SHARE_FOR_TALK).performScrollTo().performClick()
        waitForHeld(hold)
        assertEquals(emptyList(), serverMe()?.sharedTalkIds.orEmpty(), "the server has not applied the share yet")

        // Close the sheet while the save is out.
        onNode(hasContentDescription(Strings.Common.CLOSE) and hasAnyAncestor(hasTestTag("talk-sheet"))).performClick()
        u1WaitGone(hasTestTag("talk-sheet"))
        hold.release()
        u1WaitOrDump("the server to store the share") { serverMe()?.sharedTalkIds == listOf(talk1) }
        u1WaitOrDump("the controller to show the share") { f.controller.state.value.visibility.sharedTalkIds == listOf(talk1) }
        assertEquals(JsonPrimitive(false), f.server.requests("PUT", "/api/people/profile").single().body!!["open_to_meet"])

        // Interested says one of one is shared; the talk's sheet shows the share, the circle and the count of the server.
        tab("Interested")
        u1WaitForText(ProfileStrings.shareSummary(1, 1))
        // The card's own area above its people controls, not the middle, where the share switch is.
        u1WaitForNode(hasTestTag("talk-$talk1")).performScrollTo().performTouchInput { click(Offset(width / 2f, 24f)) }
        u1WaitForTag("talk-sheet")
        u1WaitForNode(isToggleable() and hasText(ProfileStrings.SHARE_FOR_TALK) and controls).assertIsOn()
        u1WaitForNode(hasText(u1CountLabel(2)) and controls)
        u1WaitForTag("see-who-$talk1")
    }

    /** Profile from Settings, which the tabs' Settings button opens first when [fromTabs]. */
    private fun ComposeUiTest.openProfile(fromTabs: Boolean = true) {
        if (fromTabs) u1WaitForNode(hasContentDescription(Strings.AppBar.SETTINGS) and hasClickAction()).performClick()
        u1WaitForNode(hasText(Strings.Settings.PROFILE) and hasClickAction()).performClick()
        u1WaitForTag("profile-screen")
    }
}
