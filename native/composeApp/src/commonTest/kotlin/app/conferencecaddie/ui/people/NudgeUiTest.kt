package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.NoPush
import app.conferencecaddie.shared.PushRegistrar
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.ui.components.SettingsGroup
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

// The nudge banner, the Nudges setting and the push switch (card and Settings), against the fake
// server and a real controller.
@OptIn(ExperimentalTestApi::class)
class NudgeUiTest {
    private val rigs = ArrayList<U3Rig>()

    private fun rig(push: PushRegistrar = NoPush): U3Rig = U3Rig(LocationAccess.Precise, push).also { rigs += it }

    @AfterTest
    fun cleanUp() = rigs.forEach { it.close() }

    /** Me and Ada around in the Hallway, and the nudge check run once. */
    private fun androidx.compose.ui.test.ComposeUiTest.nudged(rig: U3Rig): FakePerson = u3Await(rig) {
        rig.controller.updateContext(rig.context())
        rig.makeVisible()
        val ada = rig.seedAda("Hallway", located = true)
        check(rig.controller.turnOnPresence("Hallway", "") == null)
        rig.controller.backgroundCheck()
        ada
    }

    @Test
    fun theNudgeSaysWhatAndWhereButNeverWhoOrHowFar() = runComposeUiTest {
        val rig = rig()
        val ada = nudged(rig)
        val nudge = assertNotNull(rig.state.nudge)
        val sawWho = kotlinx.coroutines.flow.MutableStateFlow(false)
        u3Show(rig) { state -> U3PresenceHome(state, rig, onSeeWho = { sawWho.value = true }) }
        u3WaitForTag("nudge-banner")
        onNodeWithText(nudge.text).assertIsDisplayed()
        assertTrue(nudge.text.startsWith("Someone who's worked on "), nudge.text)
        assertTrue(nudge.text.endsWith(" is in Hallway right now"), nudge.text)
        assertFalse(nudge.text.contains("Ada"))
        assertFalse(Regex("\\d+ ?m\\b").containsMatchIn(nudge.text))

        onNodeWithText(ConnectStrings.SEE_WHO).performClick()
        waitUntil(timeoutMillis = 20_000) { sawWho.value }
        u3WaitForNoTag("nudge-banner")
        assertEquals(ada.ref, rig.state.reveal)
    }

    @Test
    fun dismissClosesTheBanner() = runComposeUiTest {
        val rig = rig()
        nudged(rig)
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        u3WaitForTag("nudge-banner")
        onNodeWithContentDescription(ConnectStrings.DISMISS).performClick()
        u3WaitForNoTag("nudge-banner")
        waitUntil(timeoutMillis = 20_000) { rig.state.nudge == null }
    }

    @Test
    fun theNudgeSettingSwitchesNudges() = runComposeUiTest {
        val rig = rig()
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
        }
        u3Show(rig) { state -> SettingsGroup("Nudges") { NudgeSetting(state, rig.host) } }
        onNodeWithText(ConnectStrings.NUDGE_SETTING_TEXT).assertIsDisplayed()
        onNode(isToggleable() and hasText(PeopleText.NUDGE_SETTING_LABEL)).assertIsOn().performClick()
        waitUntil(timeoutMillis = 20_000) { !rig.state.nudgesOn }
        onNode(isToggleable() and hasText(PeopleText.NUDGE_SETTING_LABEL)).assertIsOff()
    }

    @Test
    fun withoutNativePushThereIsNoPushSwitch() = runComposeUiTest {
        val rig = rig(NoPush)
        u3Await(rig) {
            rig.controller.updateContext(rig.context(push = true))
            rig.makeVisible()
        }
        assertFalse(rig.state.push.available)
        u3Show(rig) { state ->
            U3PresenceHome(state, rig)
            SettingsGroup("Push") { PushControls(state, rig.host, PushVariant.Settings) }
        }
        u3WaitForTag("presence-card")
        onNodeWithTag("push-card").assertDoesNotExist()
        onNodeWithTag("push-settings").assertDoesNotExist()
        onNodeWithText(PeopleText.PUSH_LABEL).assertDoesNotExist()
    }

    @Test
    fun pushShowsTheNoticeFirstThenTurnsOnAndOff() = runComposeUiTest {
        val rig = rig(FakePushRegistrar("f".repeat(40)))
        u3Await(rig) {
            rig.locked { pushPlatforms = setOf("fcm") }
            rig.controller.updateContext(rig.context(push = true))
            rig.makeVisible()
        }
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        u3WaitForTag("push-card")
        onNodeWithTag("push-switch").assertIsOff().performClick()
        u3WaitForTag("push-notice")
        onNodeWithText(PeopleText.PUSH_NOTICE).assertIsDisplayed()
        onNodeWithTag("push-switch").assertIsOn()
        assertTrue(rig.calls("PUT", "/api/push/native").isEmpty())

        onNodeWithText(ConnectStrings.TURN_ON_NUDGES).performClick()
        u3WaitForToast(rig, ConnectStrings.NUDGES_ON)
        waitUntil(timeoutMillis = 20_000) { rig.state.push.on }
        u3WaitForText(ConnectStrings.PUSH_ON)
        onNodeWithTag("push-notice").assertDoesNotExist()
        assertEquals(1, rig.calls("PUT", "/api/push/native").size)

        // Off, and on again without the notice.
        onNodeWithTag("push-switch").performClick()
        waitUntil(timeoutMillis = 20_000) { !rig.state.push.on }
        onNodeWithText(ConnectStrings.PUSH_ON).assertDoesNotExist()
        waitUntil(timeoutMillis = 20_000) { rig.calls("DELETE", "/api/push/native").size == 1 }
        onNodeWithTag("push-switch").performClick()
        waitUntil(timeoutMillis = 20_000) { rig.state.push.on }
        onNodeWithTag("push-notice").assertDoesNotExist()
    }

    @Test
    fun refusedNotificationsOfferTheSettings() = runComposeUiTest {
        val rig = rig(FakePushRegistrar(null))
        u3Await(rig) {
            rig.locked { pushPlatforms = setOf("fcm") }
            rig.controller.updateContext(rig.context(push = true))
            rig.makeVisible()
        }
        u3Show(rig) { state -> SettingsGroup("Push") { PushControls(state, rig.host, PushVariant.Settings) } }
        onNodeWithText(ConnectStrings.PUSH_SETTINGS_TEXT).assertIsDisplayed()
        onNodeWithTag("push-switch").performClick()
        onNodeWithText(ConnectStrings.TURN_ON_NUDGES).performClick()
        u3WaitForText(ConnectStrings.PUSH_DENIED)
        onNodeWithTag("push-switch").assertIsOff()
        onNodeWithText(ConnectStrings.OPEN_SETTINGS).performClick()
        waitUntil(timeoutMillis = 5_000) { rig.settingsOpened.value == 1 }
        assertFalse(rig.state.push.on)
    }

    @Test
    fun pushNeedsAVisibleProfile() = runComposeUiTest {
        val rig = rig(FakePushRegistrar("f".repeat(40)))
        u3Await(rig) {
            rig.locked { pushPlatforms = setOf("fcm") }
            rig.controller.updateContext(rig.context(push = true))
        }
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        u3WaitForTag("push-card")
        onNodeWithTag("push-switch").performClick()
        onNodeWithText(ConnectStrings.TURN_ON_NUDGES).performClick()
        u3WaitForText("${ConnectStrings.PUSH_PROFILE_NEEDED} ${PeopleCommonStrings.OPEN_MY_PROFILE}")
        assertFalse(rig.state.push.on)
    }
}
