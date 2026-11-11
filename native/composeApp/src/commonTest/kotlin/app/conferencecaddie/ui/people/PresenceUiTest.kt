package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import app.conferencecaddie.shared.GeoFix
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.shared.people.PeopleZones
import app.conferencecaddie.shared.people.Profile
import app.conferencecaddie.shared.people.Visibility
import app.conferencecaddie.shared.people.PositionChoice
import app.conferencecaddie.shared.people.PresenceMode
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// The presence card (PresenceControls) and "Still in {zone}?" (StillHereRow) against the fake
// server: turning presence on, the hour and the day, Extend, turning it off, the zone check, and the
// position step with each answer the phone's location permission can give.
@OptIn(ExperimentalTestApi::class)
class PresenceUiTest {
    private val rigs = ArrayList<U3Rig>()

    private fun rig(access: LocationAccess = LocationAccess.Precise): U3Rig = U3Rig(access).also { rigs += it }

    @AfterTest
    fun cleanUp() = rigs.forEach { it.close() }

    private fun U3Rig.presencePuts(): List<JsonObject> = calls("PUT", "/api/presence").map { it.body!! }

    @Test
    fun turningPresenceOnSendsTheWebsBodyAndShowsTheZone() = runComposeUiTest {
        val rig = rig()
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
        }
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        onNode(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL)).assertIsOff().performClick()

        // The panel: the first-time notice, the zone, how long and the spot line.
        u3WaitForTag("presence-setup")
        onNode(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL)).assertIsOn()
        onNodeWithText(PeopleText.PRESENCE_NOTICE).assertIsDisplayed()
        onNodeWithText(ConnectStrings.HOW_LONG).assertIsDisplayed()
        onNodeWithText(ConnectStrings.SPOT_HINT).assertIsDisplayed()
        onNodeWithText(ConnectStrings.NEEDS_VISIBLE_PROFILE, substring = true).assertDoesNotExist()
        onNodeWithContentDescription(ConnectStrings.ZONE).performClick()
        u3WaitForText("Hallway")
        onNodeWithText("Hallway").performClick()
        // The zone sheet (titled "Zone") closes, and the picker shows the choice.
        waitUntil(timeoutMillis = 20_000) { onAllNodesWithTextCount(ConnectStrings.ZONE) == 0 }
        onNodeWithContentDescription(ConnectStrings.ZONE).assertTextEquals("Hallway")
        onNodeWithTag("presence-spot").typeText("by the coffee cart")
        onNodeWithText(ConnectStrings.I_AM_AROUND).performClick()

        waitUntil(timeoutMillis = 20_000) { rig.state.presence.on }
        val body = rig.presencePuts().single()
        assertEquals(
            buildJsonObject {
                put("event", SLUG)
                put("zone", "Hallway")
                put("spot", "by the coffee cart")
            },
            body,
        )
        u3WaitForTag("presence-on")
        onNodeWithTag("presence-setup").assertDoesNotExist()
        onNodeWithText("Hallway · by the coffee cart").assertIsDisplayed()
        onNodeWithText(ConnectStrings.turnsOffIn(60)).assertIsDisplayed()
        // The position step follows the first time.
        onNodeWithTag("position-step").assertIsDisplayed()
        onNodeWithText(PeopleText.POSITION_EXPLAINER).assertIsDisplayed()
    }

    @Test
    fun theZonePickerListsTheRoomsThenTheFixedZones() = runComposeUiTest {
        val rig = rig()
        val state = readyState().copy(
            zones = PeopleZones.forRooms(listOf("Room 2", "Room 1", "expo hall")),
            visibility = Visibility(openToMeet = true),
            profile = Profile(displayName = "Me Myself"),
        )
        u3Show(rig) { PeopleScreenColumn { PresenceControls(state, rig.host) } }
        onNode(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL)).performClick()
        u3WaitForTag("presence-setup")
        // The first zone is preselected, and the sheet lists the rooms, then the fixed zones.
        onNodeWithContentDescription(ConnectStrings.ZONE).assertTextEquals("Room 1").performClick()
        u3WaitForText("Outside")
        val durations = PeopleText.DURATION_LABELS.values.toSet()
        val listed = onAllNodes(isSelectable()).fetchSemanticsNodes()
            .map { node -> node.config[SemanticsProperties.Text].joinToString("") { it.text } }
            .filter { it !in durations }
        assertEquals(listOf("Room 1", "Room 2", "Expo hall", "Registration", "Food and coffee", "Hallway", "Outside"), listed)
    }

    @Test
    fun theDayModeSendsUntilDayAndSaysSo() = runComposeUiTest {
        val rig = rig()
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
        }
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        onNode(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL)).performClick()
        u3WaitForTag("presence-setup")
        onNodeWithText(ConnectStrings.DAY_HINT).assertDoesNotExist()
        onNodeWithText(PeopleText.DURATION_LABELS.getValue(PresenceMode.Day)).performClick()
        onNodeWithText(ConnectStrings.DAY_HINT).assertIsDisplayed()
        onNodeWithText(ConnectStrings.I_AM_AROUND).performClick()

        waitUntil(timeoutMillis = 20_000) { rig.state.presence.on }
        assertEquals(
            buildJsonObject {
                put("event", SLUG)
                put("zone", "Expo hall")
                put("spot", "")
                put("until", "day")
            },
            rig.presencePuts().single(),
        )
        u3WaitForText(ConnectStrings.ON_UNTIL_OFF_TODAY)
        onNodeWithText(ConnectStrings.turnsOffIn(60)).assertDoesNotExist()
    }

    @Test
    fun extendStartsAFreshHourAndTheSwitchTurnsPresenceOff() = runComposeUiTest {
        val rig = rig()
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            check(rig.controller.turnOnPresence("Hallway", "") == null)
        }
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        onNodeWithText(ConnectStrings.turnsOffIn(60)).assertIsDisplayed()

        // Twenty minutes later, after the card's next minute tick.
        rig.clock.advance(20 * 60_000L)
        mainClock.advanceTimeBy(30_000)
        u3WaitForText(ConnectStrings.turnsOffIn(40))
        onNodeWithTag("presence-extend").performClick()
        u3WaitForToast(rig, ConnectStrings.EXTENDED)
        u3WaitForText(ConnectStrings.turnsOffIn(60))
        assertEquals(listOf("Hallway", "Hallway"), rig.presencePuts().map { (it["zone"] as JsonPrimitive).content }.takeLast(2))

        // Off: at once on the device, then on the server.
        onNode(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL)).performClick()
        waitUntil(timeoutMillis = 20_000) { !rig.state.presence.on }
        u3WaitForNoTag("presence-on")
        onNode(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL)).assertIsOff()
        waitUntil(timeoutMillis = 20_000) { rig.calls("DELETE", "/api/presence").size == 1 }
    }

    @Test
    fun beingAroundNeedsAVisibleProfile() = runComposeUiTest {
        val rig = rig()
        u3Await(rig) { rig.controller.updateContext(rig.context()) }
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        onNode(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL)).performClick()
        u3WaitForTag("presence-setup")
        onNodeWithText(ConnectStrings.NEEDS_VISIBLE_PROFILE, substring = true).assertIsDisplayed()
        onNodeWithText(ConnectStrings.I_AM_AROUND).performClick()
        // No device yet, so nothing is sent: the web's line, with the way to the profile.
        u3WaitForText("Make your profile visible first.", substring = true)
        onNodeWithText("Make your profile visible first. ${PeopleCommonStrings.OPEN_MY_PROFILE}").assertIsDisplayed()
        // The spot field is marked as in error, as the web's aria-invalid is.
        onNodeWithTag("presence-spot").assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Error))
        assertTrue(!rig.state.presence.on)
        // "Not now" closes the panel and puts the switch back.
        onNodeWithText(ConnectStrings.NOT_NOW).performClick()
        u3WaitForNoTag("presence-setup")
        onNode(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL)).assertIsOff()
    }

    @Test
    fun stillInConfirmsMovesAndCloses() = runComposeUiTest {
        val rig = rig()
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            check(rig.controller.turnOnPresence("Hallway", "", PresenceMode.Day) == null)
        }
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        onNodeWithTag("still-here").assertDoesNotExist()

        // Back in the foreground eleven minutes later: the zone is asked about.
        fun comeBackLater() {
            rig.controller.setForeground(false)
            rig.clock.advance(11 * 60_000L)
            rig.controller.setForeground(true)
            waitUntil(timeoutMillis = 20_000) { rig.state.presence.confirmPending }
            u3WaitForTag("still-here")
        }
        comeBackLater()
        onNodeWithText(ConnectStrings.stillIn("Hallway")).assertIsDisplayed()
        onNodeWithText(ConnectStrings.YES).assertIsDisplayed()
        // The likely zones: the fixed zones without mine, at most four, then Other….
        listOf("Expo hall", "Registration", "Food and coffee", "Outside").forEach { onNodeWithText(it).assertIsDisplayed() }
        onNodeWithText(ConnectStrings.OTHER_ZONE).assertIsDisplayed()

        // A new zone: written, and toasted.
        val before = rig.presencePuts().size
        onNodeWithText("Registration").performClick()
        u3WaitForToast(rig, ConnectStrings.nowIn("Registration"))
        u3WaitForNoTag("still-here")
        assertEquals("Registration", rig.state.presence.zone)
        assertEquals("Registration", (rig.presencePuts().drop(before).single()["zone"] as JsonPrimitive).content)

        // Yes: the same zone again, written without a toast.
        comeBackLater()
        onNodeWithText(ConnectStrings.YES).performClick()
        u3WaitForNoTag("still-here")
        assertEquals("Registration", rig.state.presence.zone)
        assertTrue(rig.toasts.value.count { it.startsWith("Now in") } == 1)

        // Close counts as yes, without a write.
        comeBackLater()
        val writes = rig.presencePuts().size
        onNodeWithContentDescription(app.conferencecaddie.ui.strings.Strings.Common.CLOSE).performClick()
        u3WaitForNoTag("still-here")
        assertEquals(writes, rig.presencePuts().size)

        // Other…: the full picker, set to the first zone that is not offered as a chip, then I'm here.
        comeBackLater()
        onNodeWithText(ConnectStrings.OTHER_ZONE).performClick()
        u3WaitForTag("still-zone")
        onNodeWithText(ConnectStrings.I_AM_HERE).performClick()
        u3WaitForNoTag("still-here")
        u3WaitForToast(rig, ConnectStrings.nowIn("Expo hall"))
        assertEquals("Expo hall", rig.state.presence.zone)
    }

    @Test
    fun usingMyPositionSendsItWithPreciseLocation() = runComposeUiTest {
        val rig = rig(LocationAccess.Precise)
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            check(rig.controller.turnOnPresence("Hallway", "") == null)
        }
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        u3WaitForTag("position-step")
        onNodeWithText(ConnectStrings.USE_MY_POSITION).performClick()
        u3WaitForToast(rig, ConnectStrings.USING_POSITION_TOAST)
        u3WaitForNoTag("position-step")
        assertEquals(PositionChoice.Yes, rig.state.presence.positionChoice)

        // The first fix goes out with the zone.
        waitUntil(timeoutMillis = 20_000) {
            rig.location.emit(GeoFix(MY_LAT, MY_LON, 12.4, rig.clock.ms))
            rig.presencePuts().any { it["location"] != null }
        }
        val located = rig.presencePuts().first { it["location"] != null }
        assertEquals(12L, ((located["location"] as JsonObject)["accuracy"] as JsonPrimitive).content.toLong())
        u3WaitForText(ConnectStrings.USING_POSITION)
        onNodeWithText(ConnectStrings.STOP_USING_POSITION).assertIsDisplayed()

        // Stop using position: the next write carries none.
        onNodeWithText(ConnectStrings.STOP_USING_POSITION).performClick()
        u3WaitForText(ConnectStrings.USE_MY_POSITION_TOO)
        waitUntil(timeoutMillis = 20_000) { rig.presencePuts().last()["location"] == null }
        onNodeWithText(ConnectStrings.USING_POSITION).assertDoesNotExist()
    }

    @Test
    fun approximateLocationSendsNoPositionAndOffersTheSettings() = runComposeUiTest {
        val rig = rig(LocationAccess.Approximate)
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            check(rig.controller.turnOnPresence("Hallway", "") == null)
        }
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        u3WaitForTag("position-step")
        onNodeWithText(ConnectStrings.USE_MY_POSITION).performClick()
        u3WaitForText(ConnectStrings.POSITION_APPROXIMATE)
        assertTrue(ConnectStrings.USING_POSITION_TOAST !in rig.toasts.value)
        onNodeWithText(ConnectStrings.USING_POSITION).assertDoesNotExist()
        onNodeWithText(ConnectStrings.OPEN_SETTINGS).performClick()
        waitUntil(timeoutMillis = 5_000) { rig.settingsOpened.value == 1 }

        // Fixes arrive, but nothing carries a position.
        repeat(3) { rig.location.emit(GeoFix(MY_LAT, MY_LON, 12.0, rig.clock.ms)) }
        waitForIdle()
        assertTrue(rig.presencePuts().none { it["location"] != null })
        assertTrue(!rig.state.presence.position)
    }

    @Test
    fun refusedLocationOffersTheSettings() = runComposeUiTest {
        val rig = rig(LocationAccess.Denied)
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            check(rig.controller.turnOnPresence("Hallway", "") == null)
        }
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        u3WaitForTag("position-step")
        onNodeWithText(ConnectStrings.USE_MY_POSITION).performClick()
        u3WaitForText(ConnectStrings.POSITION_DENIED)
        // Answered: the step is gone, and the card offers the position again.
        onNodeWithTag("position-step").assertDoesNotExist()
        onNodeWithText(ConnectStrings.USE_MY_POSITION_TOO).assertIsDisplayed()
        onNodeWithText(ConnectStrings.OPEN_SETTINGS).performClick()
        waitUntil(timeoutMillis = 5_000) { rig.settingsOpened.value == 1 }
        assertTrue(rig.presencePuts().none { it["location"] != null })
    }

    @Test
    fun withoutGpsBandsThereIsNoPositionStep() = runComposeUiTest {
        val rig = rig(LocationAccess.Precise)
        u3Await(rig) {
            rig.controller.updateContext(rig.context(gpsBands = false))
            rig.makeVisible()
            check(rig.controller.turnOnPresence("Hallway", "") == null)
        }
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        u3WaitForTag("presence-on")
        onNodeWithTag("position-step").assertDoesNotExist()
        onNodeWithText(ConnectStrings.USE_MY_POSITION_TOO).assertDoesNotExist()
        assertNull(rig.state.presence.positionChoice)
    }
}

/** How many nodes show exactly [text]. */
@OptIn(ExperimentalTestApi::class)
private fun androidx.compose.ui.test.ComposeUiTest.onAllNodesWithTextCount(text: String): Int =
    onAllNodes(androidx.compose.ui.test.hasText(text)).fetchSemanticsNodes().size
