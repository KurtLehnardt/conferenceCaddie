package app.conferencecaddie.ui.people

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.Notifier
import app.conferencecaddie.shared.ble.BleAccess
import app.conferencecaddie.shared.ble.BlePermissionKind
import app.conferencecaddie.shared.ble.BlePlatform
import app.conferencecaddie.shared.ble.BleRadioState
import app.conferencecaddie.shared.ble.BleStopReason
import app.conferencecaddie.shared.ble.InMemoryBleKeyStore
import app.conferencecaddie.shared.people.BleProblem
import app.conferencecaddie.shared.people.BleView
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.shared.people.Presence
import app.conferencecaddie.shared.people.Profile
import app.conferencecaddie.shared.people.PushView
import app.conferencecaddie.shared.people.Visibility
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

// "Find people near me by Bluetooth" (BleControls) in the presence card and in Settings: every state
// it draws, from constructed states, and the flows through a real PeopleController on the fake
// server with a fake radio and an in-memory key store.
@OptIn(ExperimentalTestApi::class)
class BleUiTest {
    private val rigs = ArrayList<U3Rig>()

    /** A rig whose phone has [radio] (none: no Bluetooth at all) and notifications as [notifier] allows. */
    private fun rig(radio: FakeUiBleRadio? = null, notifier: Notifier = FakeNotifier()): U3Rig =
        U3Rig(ble = radio?.let { BlePlatform(it, InMemoryBleKeyStore()) }, notifier = notifier).also { rigs += it }

    @AfterTest
    fun cleanUp() = rigs.forEach { it.close() }

    /** A ready state with a visible profile, presence on in the Hallway (or off) and Bluetooth as [ble]. */
    private fun bleState(ble: BleView, presenceOn: Boolean = true): PeopleUiState = readyState().copy(
        profile = Profile(displayName = "Me Myself"),
        visibility = Visibility(openToMeet = true),
        presence = if (presenceOn) Presence(on = true, zone = "Hallway", until = "2099-03-03T11:00:00Z", noticeSeen = true) else Presence(noticeSeen = true),
        ble = ble,
    )

    /** Me visible and around in the Hallway at a backend that offers derived-v1 Bluetooth. */
    private fun ComposeUiTest.aroundWithBluetooth(rig: U3Rig) = u3Await(rig) {
        rig.controller.updateContext(rig.context(ble = true))
        rig.makeVisible()
        check(rig.controller.turnOnPresence("Hallway", "") == null)
    }

    /** The `ble` of every presence write that carried one, oldest first. */
    private fun U3Rig.bleWrites(): List<Boolean> =
        calls("PUT", "/api/presence").mapNotNull { (it.body!!["ble"] as? JsonPrimitive)?.booleanOrNull }

    private val politeLiveRegion = SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite)

    /** The switch is read with the line under it ([hint]), as the web's aria-describedby="pp-ble-hint". */
    private fun describedBy(hint: String) = SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf(BleStrings.switchDescription(hint)))

    /** Opens the setup panel from the switch and taps Turn on. */
    private fun ComposeUiTest.turnOnThroughTheNotice() {
        onNodeWithTag("ble-switch").performScrollTo().assertIsOff().performClick()
        u3WaitForTag("ble-setup")
        onNodeWithTag("ble-turn-on").performScrollTo().performClick()
    }

    // ---------------------------------------------------------------------------------------------
    // States

    @Test
    fun nothingShowsWithoutBluetooth() = runComposeUiTest {
        val rig = rig()
        val state = bleState(BleView(available = false))
        u3Show(rig) {
            PeopleScreenColumn {
                PresenceControls(state, rig.host)
                NudgeSettings(state, rig.host)
            }
        }
        onNodeWithTag("presence-card").assertExists()
        onNodeWithTag("set-nudges").assertExists()
        onNodeWithTag("ble-card").assertDoesNotExist()
        onNodeWithTag("set-ble").assertDoesNotExist()
        assertTrue(u3NoText(PeopleText.BLE_LABEL))
    }

    @Test
    fun presenceOffDisablesTheSwitchAndSaysWhy() = runComposeUiTest {
        val rig = rig()
        val state = bleState(BleView(available = true), presenceOn = false)
        u3Show(rig) { PeopleScreenColumn { PresenceControls(state, rig.host) } }
        onNodeWithTag("ble-card").assertIsDisplayed()
        onNodeWithTag("ble-switch").assertIsNotEnabled().assertIsOff().assert(describedBy(PeopleText.BLE_NEEDS_PRESENCE))
        onNodeWithTag("ble-hint").assertTextEquals(PeopleText.BLE_NEEDS_PRESENCE)
    }

    @Test
    fun offSitsUnderThePushSwitchAndSaysWhoCanBeFound() = runComposeUiTest {
        val rig = rig()
        val state = bleState(BleView(available = true)).copy(push = PushView(available = true))
        u3Show(rig) { PeopleScreenColumn { PresenceControls(state, rig.host) } }
        onNode(hasTestTag("ble-card") and hasAnyAncestor(hasTestTag("presence-card"))).assertIsDisplayed()
        assertTrue(onNodeWithTag("push-card").getUnclippedBoundsInRoot().bottom <= onNodeWithTag("ble-card").getUnclippedBoundsInRoot().top)
        onNodeWithTag("ble-switch")
            .assertIsEnabled()
            .assertIsOff()
            .assert(hasText(PeopleText.BLE_LABEL))
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch))
            .assert(describedBy(BleStrings.HINT_OFF))
            .assertHeightIsAtLeast(44.dp)
        assertEquals("Find people near me by Bluetooth (phone can stay in your pocket). Only people who also turned this on can be found.", BleStrings.switchDescription(BleStrings.HINT_OFF))
        onNodeWithTag("ble-hint").assertTextEquals(BleStrings.HINT_OFF)
        onNodeWithTag("ble-setup").assertDoesNotExist()
        onNodeWithTag("ble-open-settings").assertDoesNotExist()
    }

    @Test
    fun theFirstTurnOnExplainsThePermissionOfEachPlatformAndNotNowCloses() = runComposeUiTest {
        val rig = rig()
        var kind by mutableStateOf(BlePermissionKind.NearbyDevices)
        u3Show(rig) { PeopleScreenColumn { BleControls(bleState(BleView(available = true, permission = kind)), rig.host, BleVariant.Card) } }
        for (k in BlePermissionKind.entries) {
            kind = k
            waitForIdle()
            onNodeWithTag("ble-switch").performClick()
            u3WaitForTag("ble-setup")
            // The switch shows on while the panel asks.
            onNodeWithTag("ble-switch").assertIsOn()
            onNode(hasText(PeopleText.BLE_NOTICE) and hasAnyAncestor(hasTestTag("ble-notice"))).assertIsDisplayed()
            // The web's role="region" aria-label="About finding people by Bluetooth".
            onNodeWithTag("ble-notice").assert(SemanticsMatcher.expectValue(SemanticsProperties.PaneTitle, "About finding people by Bluetooth"))
            onNode(hasText(BleStrings.permissionLine(k)) and hasAnyAncestor(hasTestTag("ble-notice"))).assertIsDisplayed()
            for (other in BlePermissionKind.entries - k) assertTrue(u3NoText(BleStrings.permissionLine(other)), "$k shows the line of $other")
            onNodeWithTag("ble-turn-on").assertTextEquals(BleStrings.TURN_ON).assertIsEnabled()
            onNodeWithTag("ble-not-now").assertTextEquals(ConnectStrings.NOT_NOW).performClick()
            u3WaitForNoTag("ble-setup")
            onNodeWithTag("ble-switch").assertIsOff()
        }
        // Nothing was asked of the controller or sent.
        assertTrue(rig.calls.value.isEmpty())
    }

    @Test
    fun onSaysItListensWithTheIphoneCaveatAndTheNotificationsLine() = runComposeUiTest {
        val rig = rig()
        var ble by mutableStateOf(BleView(available = true, on = true, noticeSeen = true))
        u3Show(rig) { PeopleScreenColumn { BleControls(bleState(ble), rig.host, BleVariant.Card) } }
        onNodeWithTag("ble-switch").assertIsOn().assertIsEnabled().assert(describedBy(BleStrings.HINT_ON))
        onNodeWithTag("ble-hint").assertTextEquals(BleStrings.HINT_ON)
        onNodeWithTag("ble-ios-caveat").assertDoesNotExist()
        onNodeWithTag("ble-notifications").assertDoesNotExist()
        onNodeWithTag("ble-open-settings").assertDoesNotExist()

        // On an iPhone (its permission is Bluetooth) one more line says what iPhones cannot do.
        ble = ble.copy(permission = BlePermissionKind.Bluetooth)
        waitForIdle()
        onNodeWithTag("ble-ios-caveat").assertTextEquals(BleStrings.IOS_CAVEAT)
        onNodeWithTag("ble-hint").assertTextEquals(BleStrings.HINT_ON)

        // An Android phone without the connectable set (Android 13 and older) says iPhones may not find it.
        onNodeWithTag("ble-android-caveat").assertDoesNotExist()
        ble = ble.copy(permission = BlePermissionKind.NearbyDevices, hiddenFromIphones = true)
        waitForIdle()
        onNodeWithTag("ble-android-caveat").assertTextEquals(BleStrings.ANDROID_CAVEAT)
        onNodeWithTag("ble-ios-caveat").assertDoesNotExist()

        // Notifications refused: the web's words in the error style, and the way to the settings.
        ble = ble.copy(permission = BlePermissionKind.NearbyDevices, notificationsAllowed = false, hiddenFromIphones = false)
        waitForIdle()
        onNodeWithTag("ble-ios-caveat").assertDoesNotExist()
        onNodeWithTag("ble-android-caveat").assertDoesNotExist()
        onNodeWithTag("ble-notifications").assertTextEquals(PeopleText.BLE_NOTIFICATIONS).assert(politeLiveRegion)
        onNodeWithTag("ble-open-settings").assertTextEquals(ConnectStrings.OPEN_SETTINGS).assertHeightIsAtLeast(44.dp).performClick()
        waitUntil(timeoutMillis = 5_000) { rig.settingsOpened.value == 1 }
    }

    @Test
    fun eachProblemShowsTheRuntimesWordsAndRefusalsOfferTheSettings() = runComposeUiTest {
        val rig = rig()
        var ble by mutableStateOf(BleView(available = true, noticeSeen = true))
        u3Show(rig) { PeopleScreenColumn { BleControls(bleState(ble), rig.host, BleVariant.Card) } }
        val cases = listOf(
            Triple(BleProblem.BluetoothOff, "Turn on Bluetooth first.", false),
            // Android 8 to 11 with the Location switch off; the switch is in the system's quick
            // settings, not on the app's page, so there is no "Open settings".
            Triple(BleProblem.LocationOff, "Turn on Location first. This phone needs it to find people over Bluetooth.", false),
            Triple(BleProblem.Unsupported, "This phone's Bluetooth can't send the code.", false),
            Triple(BleProblem.PermissionDenied, "Caddie needs the Nearby devices permission for this. You can allow it in Settings.", true),
            Triple(BleProblem.PermissionBlocked, "Caddie needs the Nearby devices permission for this. You can allow it in Settings.", true),
            Triple(BleProblem.OtherDevice, PeopleText.BLE_OTHER_DEVICE, false),
            Triple(BleProblem.Failed, PeopleText.BLE_START_FAILED, false),
        )
        for ((problem, words, settings) in cases) {
            ble = BleView(available = true, noticeSeen = true, problem = problem, message = PeopleText.bleProblemMessage(problem))
            waitForIdle()
            onNodeWithTag("ble-hint").assertTextEquals(words).assert(politeLiveRegion)
            onNodeWithTag("ble-switch").assert(describedBy(words))
            if (settings) onNodeWithTag("ble-open-settings").assertIsDisplayed() else onNodeWithTag("ble-open-settings").assertDoesNotExist()
            // A problem leaves the switch off and usable, to try again.
            onNodeWithTag("ble-switch").assertIsOff().assertIsEnabled()
        }

        // Failed shows whatever the runtime said; an iPhone's refusal names its own permission.
        ble = BleView(available = true, noticeSeen = true, problem = BleProblem.Failed, message = "Removing your profile has not finished yet.")
        waitForIdle()
        onNodeWithTag("ble-hint").assertTextEquals("Removing your profile has not finished yet.")
        ble = BleView(
            available = true,
            noticeSeen = true,
            permission = BlePermissionKind.Bluetooth,
            problem = BleProblem.PermissionBlocked,
            message = PeopleText.blePermissionMessage(BlePermissionKind.Bluetooth),
        )
        waitForIdle()
        onNodeWithTag("ble-hint").assertTextEquals("Caddie needs the Bluetooth permission for this. You can allow it in Settings.")
        onNodeWithTag("ble-open-settings").performClick()
        waitUntil(timeoutMillis = 5_000) { rig.settingsOpened.value == 1 }

        // Presence ended during an attempt: once it is back on, that problem no longer applies.
        ble = BleView(available = true, noticeSeen = true, problem = BleProblem.NeedsPresence, message = PeopleText.BLE_NEEDS_PRESENCE)
        waitForIdle()
        onNodeWithTag("ble-hint").assertTextEquals(BleStrings.HINT_OFF)
    }

    @Test
    fun theSettingsGroupShowsOnlyWhereBluetoothIsAvailable() = runComposeUiTest {
        val rig = rig()
        var available by mutableStateOf(false)
        u3Show(rig) {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                SettingsPeople(bleState(BleView(available = available)).copy(push = PushView(available = true)), rig.host)
            }
        }
        onNodeWithTag("set-push").assertExists()
        onNodeWithTag("set-ble").assertDoesNotExist()
        available = true
        waitForIdle()
        onNodeWithTag("set-ble").assertExists()
        onNodeWithText(BleStrings.SETTINGS_GROUP.uppercase()).assertExists()
        // Last of the people groups: after Nudges and Push.
        val tops = listOf("set-nudges", "set-push", "set-ble").map { onNodeWithTag(it).getUnclippedBoundsInRoot().top }
        assertEquals(tops.sorted(), tops)
        onNode(hasTestTag("ble-switch") and hasAnyAncestor(hasTestTag("set-ble")))
            .performScrollTo()
            .assertIsOff()
            .assert(hasText(PeopleText.BLE_LABEL))
            .assertHeightIsAtLeast(48.dp)
        onNodeWithTag("ble-hint").assertTextEquals(BleStrings.HINT_OFF)
    }

    // ---------------------------------------------------------------------------------------------
    // Flows through the controller

    @Test
    fun turningOnFromTheNoticeWritesBleTrueThenOffWritesBleFalse() = runComposeUiTest {
        val radio = FakeUiBleRadio()
        val rig = rig(radio)
        aroundWithBluetooth(rig)
        assertTrue(rig.state.ble.available)
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        u3WaitForTag("ble-card")
        onNodeWithTag("ble-switch").performScrollTo().assertIsOff().performClick()
        u3WaitForTag("ble-setup")
        // Nothing is asked or sent before the person accepts the explanation.
        assertEquals(0, radio.requests.value + radio.starts.value)
        assertTrue(rig.bleWrites().isEmpty())

        onNodeWithTag("ble-turn-on").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { rig.state.ble.on }
        assertEquals(listOf(true), rig.bleWrites())
        // The write with ble: true repeats presence as it stands.
        assertEquals("Hallway", (rig.calls("PUT", "/api/presence").last().body!!["zone"] as JsonPrimitive).content)
        u3WaitForNoTag("ble-setup")
        onNodeWithTag("ble-switch").assertIsOn()
        onNodeWithTag("ble-hint").assertTextEquals(BleStrings.HINT_ON)
        assertTrue(radio.running)
        assertTrue(rig.state.ble.noticeSeen)

        // Off tells the server and keeps presence.
        onNodeWithTag("ble-switch").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { !rig.state.ble.on && rig.bleWrites() == listOf(true, false) }
        assertTrue(rig.state.presence.on)
        assertFalse(radio.running)
        onNodeWithTag("ble-switch").assertIsOff()
        onNodeWithTag("ble-hint").assertTextEquals(BleStrings.HINT_OFF)

        // On again: the notice was accepted at this conference, so it starts at once.
        onNodeWithTag("ble-switch").performClick()
        waitUntil(timeoutMillis = 20_000) { rig.state.ble.on }
        onNodeWithTag("ble-setup").assertDoesNotExist()
        assertEquals(listOf(true, false, true), rig.bleWrites())
    }

    @Test
    fun startingShowsWhileTheSystemPromptIsUp() = runComposeUiTest {
        val prompt = CompletableDeferred<Unit>()
        val radio = FakeUiBleRadio().apply {
            access = BleAccess.NotAsked
            this.prompt = prompt
        }
        val rig = rig(radio)
        aroundWithBluetooth(rig)
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        turnOnThroughTheNotice()
        waitUntil(timeoutMillis = 20_000) { radio.requests.value == 1 }
        u3WaitForText(BleStrings.STARTING)
        onNodeWithTag("ble-turn-on").assertTextEquals(BleStrings.STARTING).assertIsNotEnabled()
        onNodeWithTag("ble-not-now").assertIsNotEnabled()
        onNodeWithTag("ble-switch")
            .assertIsOn()
            .assertIsNotEnabled()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, BleStrings.STARTING))
        prompt.complete(Unit)
        waitUntil(timeoutMillis = 20_000) { rig.state.ble.on }
        u3WaitForNoTag("ble-setup")
        onNodeWithTag("ble-switch").assertIsEnabled().assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription))
    }

    @Test
    fun aRefusedPermissionSaysSoAndOffersTheSettings() = runComposeUiTest {
        val radio = FakeUiBleRadio().apply {
            access = BleAccess.NotAsked
            afterRequest = BleAccess.Denied
        }
        val rig = rig(radio)
        aroundWithBluetooth(rig)
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        turnOnThroughTheNotice()
        waitUntil(timeoutMillis = 20_000) { rig.state.ble.problem == BleProblem.PermissionDenied }
        onNodeWithTag("ble-hint").assertTextEquals(PeopleText.BLE_PERMISSION).assert(politeLiveRegion)
        // As on the web, the panel stays open under a failed turn-on, to try again.
        onNodeWithTag("ble-setup").assertExists()
        onNodeWithTag("ble-open-settings").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) { rig.settingsOpened.value == 1 }
        assertTrue(rig.bleWrites().isEmpty())
        assertFalse(radio.running)

        // Refused for good: no second prompt, the same words.
        radio.access = BleAccess.Blocked
        onNodeWithTag("ble-turn-on").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { rig.state.ble.problem == BleProblem.PermissionBlocked }
        assertEquals(1, radio.requests.value)
        onNodeWithTag("ble-hint").assertTextEquals(PeopleText.BLE_PERMISSION)
        onNodeWithTag("ble-open-settings").assertExists()

        // The switch off clears the words.
        onNodeWithTag("ble-switch").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { rig.state.ble.problem == null }
        u3WaitForNoTag("ble-setup")
        onNodeWithTag("ble-hint").assertTextEquals(BleStrings.HINT_OFF)
        onNodeWithTag("ble-open-settings").assertDoesNotExist()
        assertTrue(rig.bleWrites().isEmpty())
    }

    @Test
    fun bluetoothOffOnThePhoneSaysTurnOnBluetoothFirst() = runComposeUiTest {
        val radio = FakeUiBleRadio().apply { radioState = BleRadioState.PoweredOff }
        val rig = rig(radio)
        aroundWithBluetooth(rig)
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        turnOnThroughTheNotice()
        waitUntil(timeoutMillis = 20_000) { rig.state.ble.problem == BleProblem.BluetoothOff }
        onNodeWithTag("ble-hint").assertTextEquals(PeopleText.BLE_BLUETOOTH_OFF)
        onNodeWithTag("ble-open-settings").assertDoesNotExist()
        assertTrue(rig.bleWrites().isEmpty())

        // Switched on: it starts. Switched off while it runs: it stops, says why, and tells the
        // People tab (state.notice, which the tab shows as a toast).
        radio.radioState = BleRadioState.Ready
        onNodeWithTag("ble-turn-on").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { rig.state.ble.on }
        onNodeWithTag("ble-hint").assertTextEquals(BleStrings.HINT_ON)
        radio.stopBySelf(BleStopReason.BluetoothOff)
        waitUntil(timeoutMillis = 20_000) { !rig.state.ble.on && rig.state.ble.problem == BleProblem.BluetoothOff }
        // The notice is published just after the stop itself, so it is waited for too.
        waitUntil(timeoutMillis = 20_000) { rig.state.notice != null }
        assertEquals(PeopleText.BLE_STOPPED_BLUETOOTH_OFF, rig.state.notice?.message)
        onNodeWithTag("ble-switch").assertIsOff()
        onNodeWithTag("ble-hint").assertTextEquals(PeopleText.BLE_BLUETOOTH_OFF)
    }

    @Test
    fun refusedNotificationsLeaveItRunningAndSaySo() = runComposeUiTest {
        val radio = FakeUiBleRadio()
        val rig = rig(radio, FakeNotifier(allowed = false))
        aroundWithBluetooth(rig)
        u3Show(rig) { state -> U3PresenceHome(state, rig) }
        turnOnThroughTheNotice()
        waitUntil(timeoutMillis = 20_000) { rig.state.ble.on }
        onNodeWithTag("ble-hint").assertTextEquals(BleStrings.HINT_ON)
        onNodeWithTag("ble-notifications").assertTextEquals(PeopleText.BLE_NOTIFICATIONS)
        onNodeWithTag("ble-open-settings").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) { rig.settingsOpened.value == 1 }
    }

    @Test
    fun theSettingsSwitchDrivesTheSameStateAndFollowsPresence() = runComposeUiTest {
        val radio = FakeUiBleRadio()
        val rig = rig(radio)
        aroundWithBluetooth(rig)
        u3Show(rig) { state -> Column(Modifier.verticalScroll(rememberScrollState())) { NudgeSettings(state, rig.host) } }
        u3WaitForTag("set-ble")
        onNodeWithTag("ble-card").assertDoesNotExist()
        onNodeWithTag("ble-switch").performScrollTo().assertIsOff().performClick()
        u3WaitForTag("ble-setup")
        onNode(hasText(PeopleText.BLE_NOTICE) and hasAnyAncestor(hasTestTag("set-ble"))).assertExists()
        onNodeWithTag("ble-turn-on").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { rig.state.ble.on }
        assertEquals(listOf(true), rig.bleWrites())
        onNodeWithTag("ble-switch").assertIsOn()
        onNodeWithTag("ble-hint").assertTextEquals(BleStrings.HINT_ON)

        onNodeWithTag("ble-switch").performClick()
        waitUntil(timeoutMillis = 20_000) { !rig.state.ble.on && rig.bleWrites() == listOf(true, false) }
        onNodeWithTag("ble-hint").assertTextEquals(BleStrings.HINT_OFF)

        // On again, then presence off takes it with it (on the device; the presence delete ends the
        // server's session), and the switch waits for presence.
        onNodeWithTag("ble-switch").performClick()
        waitUntil(timeoutMillis = 20_000) { rig.state.ble.on }
        u3Await(rig) { rig.controller.turnOffPresence() }
        waitUntil(timeoutMillis = 20_000) { !rig.state.ble.on }
        assertFalse(radio.running)
        onNodeWithTag("ble-switch").assertIsOff().assertIsNotEnabled()
        onNodeWithTag("ble-hint").assertTextEquals(PeopleText.BLE_NEEDS_PRESENCE)
        assertEquals(listOf(true, false, true), rig.bleWrites())
    }
}
