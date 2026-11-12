package app.conferencecaddie.ui.people

import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.ble.BleAccess
import app.conferencecaddie.shared.ble.BlePlatform
import app.conferencecaddie.shared.ble.InMemoryBleKeyStore
import app.conferencecaddie.shared.people.BleProblem
import app.conferencecaddie.shared.people.PeopleError
import app.conferencecaddie.shared.people.PositionChoice
import app.conferencecaddie.shared.people.PresenceMode
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.CompletableDeferred

// The presence card's actions (with "Still in", the push switch and Bluetooth inside it) against the
// fake server, at the two moments where an action used to go wrong.
//
// Each action is held while it is under way: at PeopleController.beforeActionReturns (the screens
// already show the change, and the action has not returned; HeldAction), or as a request the fake
// server holds. Leaving: the card (or the "Still in" row) leaves the composition meanwhile, as when the
// People home is scrolled or another tab opens. The answer must still come as a toast, which a
// coroutine of the card's own scope could not give, since leaving cancels that scope.
//
// Double tap: two taps in one frame, with the first action held so it cannot finish between them.
// A later presence write, which queues behind any second one, then shows that one write was sent.
@OptIn(ExperimentalTestApi::class)
class PresenceActionsUiTest {
    private val rigs = ArrayList<U3Rig>()

    private fun rig(access: LocationAccess = LocationAccess.Precise): U3Rig = U3Rig(access).also { rigs += it }

    @AfterTest
    fun cleanUp() = rigs.forEach { it.close() }

    /** Whether the People home's presence parts are composed; the tests set it false to leave. */
    private val shown = mutableStateOf(true)

    // As the People home's list does for its items, what the card saves when it leaves comes back with it.
    private fun ComposeUiTest.showHome(rig: U3Rig) = u3Show(rig) { state ->
        val items = rememberSaveableStateHolder()
        if (shown.value) items.SaveableStateProvider("top") { U3PresenceHome(state, rig) }
    }

    private fun ComposeUiTest.comeBack() {
        shown.value = true
        u3WaitForTag("presence-card")
    }

    private fun ComposeUiTest.leave() {
        shown.value = false
        u3WaitForNoTag("presence-card")
    }

    private fun U3Rig.presencePuts(): Int = calls("PUT", "/api/presence").size

    /** A visible profile with presence on in [zone], for [mode]. */
    private fun ComposeUiTest.presenceOn(rig: U3Rig, mode: PresenceMode = PresenceMode.Hour, zone: String = "Hallway") {
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            check(rig.controller.turnOnPresence(zone, "", mode) == null)
        }
    }

    /** Back in the foreground eleven minutes later: "Still in {zone}?" shows. */
    private fun ComposeUiTest.stillInShows(rig: U3Rig) {
        rig.controller.setForeground(false)
        rig.clock.advance(11 * 60_000L)
        rig.controller.setForeground(true)
        waitUntil(timeoutMillis = 20_000) { rig.state.presence.confirmPending }
        u3WaitForTag("still-here")
    }

    /** Waits until the presence writes asked for so far have been sent, by sending one more after them. */
    private fun ComposeUiTest.afterQueuedWrites(rig: U3Rig) {
        u3Await(rig) { check(rig.controller.extendPresence() == null) }
    }

    // --- Leaving while the action is under way ----------------------------------------------------

    @Test
    fun aStillInAnswerIsToastedAfterTheRowHasLeft() = runComposeUiTest {
        val rig = rig()
        presenceOn(rig, PresenceMode.Day)
        showHome(rig)
        stillInShows(rig)

        val held = HeldAction(rig.controller) { rig.state.presence.zone == "Registration" }
        onNodeWithText("Registration").performClick()
        waitUntil(timeoutMillis = 20_000) { held.hasArrived }
        // The answer is published, so the row has gone while confirmZone has yet to return.
        u3WaitForNoTag("still-here")
        held.release()
        u3WaitForToast(rig, ConnectStrings.nowIn("Registration"))
    }

    @Test
    fun anExtendIsToastedAfterTheCardHasLeft() = runComposeUiTest {
        val rig = rig()
        presenceOn(rig)
        showHome(rig)

        val before = rig.presencePuts()
        val held = HeldAction(rig.controller) { rig.presencePuts() > before }
        onNodeWithTag("presence-extend").performClick()
        waitUntil(timeoutMillis = 20_000) { held.hasArrived }
        leave()
        held.release()
        u3WaitForToast(rig, ConnectStrings.EXTENDED)
    }

    @Test
    fun aTurnOnThatFailsAfterTheCardHasLeftSaysSoInAToast() = runComposeUiTest {
        val rig = rig()
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
        }
        showHome(rig)
        onNode(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL)).performClick()
        u3WaitForTag("presence-setup")

        rig.server.failure = FakeFailure.ServerError(503)
        val hold = rig.server.hold("PUT", "/api/presence")
        onNodeWithText(ConnectStrings.I_AM_AROUND).performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        // The error goes under the panel while the card shows; the card has gone, so it is a toast.
        leave()
        hold.release()
        waitUntil(timeoutMillis = 20_000) { rig.toasts.value.isNotEmpty() }
        assertEquals(listOf(PeopleError.UNAVAILABLE_MESSAGE), rig.toasts.value)
        rig.server.failure = FakeFailure.None
    }

    @Test
    fun usingMyPositionIsToastedAfterTheCardHasLeft() = runComposeUiTest {
        val rig = rig(LocationAccess.Precise)
        presenceOn(rig)
        showHome(rig)
        u3WaitForTag("position-step")

        val held = HeldAction(rig.controller) { rig.state.presence.positionChoice == PositionChoice.Yes }
        onNodeWithText(ConnectStrings.USE_MY_POSITION).performClick()
        waitUntil(timeoutMillis = 20_000) { held.hasArrived }
        leave()
        held.release()
        u3WaitForToast(rig, ConnectStrings.USING_POSITION_TOAST)
    }

    @Test
    fun aRefusedPositionIsToastedAfterTheCardHasLeft() = runComposeUiTest {
        val rig = rig(LocationAccess.Denied)
        presenceOn(rig)
        showHome(rig)
        u3WaitForTag("position-step")

        val held = HeldAction(rig.controller) { rig.state.presence.positionChoice == PositionChoice.No }
        onNodeWithText(ConnectStrings.USE_MY_POSITION).performClick()
        waitUntil(timeoutMillis = 20_000) { held.hasArrived }
        // Shown under the position step while the card shows; the card has gone, so it is a toast.
        leave()
        held.release()
        u3WaitForToast(rig, ConnectStrings.POSITION_DENIED)
        // With the way to the system settings, as under the position step.
        assertEquals(ConnectStrings.OPEN_SETTINGS, rig.toastActions.value.last())
    }

    /** A rig whose phone gets a push token (or none, as a refused permission), at a backend with FCM push. */
    private fun ComposeUiTest.pushRig(registrar: FakePushRegistrar = FakePushRegistrar("f".repeat(40)), noticeSeen: Boolean = false): U3Rig {
        val rig = U3Rig(push = registrar).also { rigs += it }
        u3Await(rig) {
            rig.locked { pushPlatforms = setOf("fcm") }
            rig.controller.updateContext(rig.context(push = true))
            rig.makeVisible()
            check(rig.controller.turnOnPresence("Hallway", "") == null)
            if (noticeSeen) rig.controller.markPushNoticeSeen()
        }
        return rig
    }

    @Test
    fun nudgesOnIsToastedAfterTheCardHasLeft() = runComposeUiTest {
        val rig = pushRig()
        showHome(rig)
        u3WaitForTag("push-card")
        onNodeWithTag("push-switch").performScrollTo().performClick()
        u3WaitForTag("push-notice")

        val hold = rig.server.hold("PUT", "/api/push/native")
        onNodeWithText(ConnectStrings.TURN_ON_NUDGES).performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        leave()
        hold.release()
        u3WaitForToast(rig, ConnectStrings.NUDGES_ON)
    }

    @Test
    fun refusedNotificationsAreToastedAfterTheCardHasLeft() = runComposeUiTest {
        val registrar = FakePushRegistrar(null)
        val rig = pushRig(registrar, noticeSeen = true)
        showHome(rig)
        u3WaitForTag("push-card")

        val held = HeldAction(rig.controller) { registrar.registers > 0 }
        onNodeWithTag("push-switch").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { held.hasArrived }
        // Shown under the switch while the card shows; the card has gone, so it is a toast.
        leave()
        held.release()
        u3WaitForToast(rig, ConnectStrings.PUSH_DENIED)
        // With the way to the system settings, as under the switch.
        assertEquals(ConnectStrings.OPEN_SETTINGS, rig.toastActions.value.last())
    }

    // --- A setup panel closed while its card was away ----------------------------------------------
    // The list keeps the card's saved state objects while it is away, so an action that finishes on
    // the app's scope closes the panel the card comes back with. On the card's own scope it never
    // could: that scope ends when the card leaves.

    @Test
    fun aTurnOnThatFinishesWhileTheCardIsAwayClosesItsPanel() = runComposeUiTest {
        val rig = rig()
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
        }
        showHome(rig)
        onNode(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL)).performClick()
        u3WaitForTag("presence-setup")

        val hold = rig.server.hold("PUT", "/api/presence")
        onNodeWithText(ConnectStrings.I_AM_AROUND).performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        leave()
        hold.release()
        waitUntil(timeoutMillis = 20_000) { rig.state.presence.on }
        // Back with presence on: the panel that asked has closed.
        comeBack()
        u3WaitForTag("presence-on")
        u3WaitForNoTag("presence-setup")
    }

    @Test
    fun aBluetoothStartThatFinishesWhileTheCardIsAwayClosesItsPanel() = runComposeUiTest {
        val prompt = CompletableDeferred<Unit>()
        val radio = FakeUiBleRadio().apply {
            access = BleAccess.NotAsked
            this.prompt = prompt
        }
        val rig = bluetoothRig(radio)
        showHome(rig)
        onNodeWithTag("ble-switch").performScrollTo().performClick()
        u3WaitForTag("ble-setup")
        onNodeWithTag("ble-turn-on").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { radio.requests.value == 1 }
        leave()
        prompt.complete(Unit)
        waitUntil(timeoutMillis = 20_000) { rig.state.ble.on }
        comeBack()
        u3WaitForTag("ble-card")
        u3WaitForNoTag("ble-setup")
    }

    /** Me visible and around in the Hallway at a backend that offers derived-v1 Bluetooth, on a phone with [radio]. */
    private fun ComposeUiTest.bluetoothRig(radio: FakeUiBleRadio): U3Rig {
        val rig = U3Rig(ble = BlePlatform(radio, InMemoryBleKeyStore()), notifier = FakeNotifier()).also { rigs += it }
        u3Await(rig) {
            rig.controller.updateContext(rig.context(ble = true))
            rig.makeVisible()
            check(rig.controller.turnOnPresence("Hallway", "") == null)
        }
        return rig
    }

    // --- A double tap ------------------------------------------------------------------------------

    @Test
    fun aDoubleTapOnTurnOnNudgesRegistersOnce() = runComposeUiTest {
        val rig = pushRig()
        showHome(rig)
        u3WaitForTag("push-card")
        onNodeWithTag("push-switch").performScrollTo().performClick()
        u3WaitForTag("push-notice")

        val hold = rig.server.hold("PUT", "/api/push/native")
        doubleTap(onNodeWithText(ConnectStrings.TURN_ON_NUDGES).performScrollTo())
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        hold.release()
        u3WaitForToast(rig, ConnectStrings.NUDGES_ON)
        // A later registration queues behind any second one on its way to the server.
        u3Await(rig) { check(rig.controller.enablePush() == app.conferencecaddie.shared.people.PushOutcome.On) }
        assertEquals(2, rig.calls("PUT", "/api/push/native").size, "the turn-on and the later one, and no second turn-on")
    }

    @Test
    fun aDoubleTapOnAStillInZoneSendsOneWrite() = runComposeUiTest {
        val rig = rig()
        presenceOn(rig, PresenceMode.Day)
        showHome(rig)
        stillInShows(rig)
        val before = rig.presencePuts()

        val hold = rig.server.hold("PUT", "/api/presence")
        doubleTap(onNodeWithText("Registration"))
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        hold.release()
        waitUntil(timeoutMillis = 20_000) { rig.state.presence.zone == "Registration" && !rig.state.presence.confirmPending }
        afterQueuedWrites(rig)
        assertEquals(before + 2, rig.presencePuts(), "the answer and the later write, and no second answer")
    }

    @Test
    fun aDoubleTapOnExtendSendsOneWrite() = runComposeUiTest {
        val rig = rig()
        presenceOn(rig)
        showHome(rig)
        val before = rig.presencePuts()

        val hold = rig.server.hold("PUT", "/api/presence")
        doubleTap(onNodeWithTag("presence-extend"))
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        hold.release()
        u3WaitForToast(rig, ConnectStrings.EXTENDED)
        afterQueuedWrites(rig)
        assertEquals(before + 2, rig.presencePuts(), "the Extend and the later write, and no second Extend")
    }

    @Test
    fun aDoubleTapOnImAroundSendsOneWrite() = runComposeUiTest {
        val rig = rig()
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
        }
        showHome(rig)
        onNode(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL)).performClick()
        u3WaitForTag("presence-setup")
        val before = rig.presencePuts()

        val hold = rig.server.hold("PUT", "/api/presence")
        doubleTap(onNodeWithText(ConnectStrings.I_AM_AROUND))
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        hold.release()
        u3WaitForNoTag("presence-setup")
        afterQueuedWrites(rig)
        assertEquals(before + 2, rig.presencePuts(), "the turn-on and the later write, and no second turn-on")
    }

    @Test
    fun aDoubleTapOnBluetoothsTurnOnAsksOnce() = runComposeUiTest {
        // The prompt is held, so the first attempt is still under way at the second tap; it is refused.
        val prompt = CompletableDeferred<Unit>()
        val radio = FakeUiBleRadio().apply {
            access = BleAccess.NotAsked
            afterRequest = BleAccess.Denied
            this.prompt = prompt
        }
        val rig = bluetoothRig(radio)
        showHome(rig)
        onNodeWithTag("ble-switch").performScrollTo().performClick()
        u3WaitForTag("ble-setup")
        doubleTap(onNodeWithTag("ble-turn-on").performScrollTo())
        waitUntil(timeoutMillis = 20_000) { radio.requests.value >= 1 }
        prompt.complete(Unit)
        waitUntil(timeoutMillis = 20_000) { rig.state.ble.problem == BleProblem.PermissionDenied }
        // A later attempt queues behind any second one and asks again: two prompts in all means the
        // double tap asked once.
        u3Await(rig) { rig.controller.turnOnBluetooth() }
        assertEquals(2, radio.requests.value)
    }

    @Test
    fun aDoubleTapOnZoneOnlySendsOneWrite() = runComposeUiTest {
        val rig = rig(LocationAccess.Precise)
        presenceOn(rig)
        showHome(rig)
        u3WaitForTag("position-step")
        val before = rig.presencePuts()

        // Zone only writes presence again without a position.
        val hold = rig.server.hold("PUT", "/api/presence")
        doubleTap(onNodeWithText(ConnectStrings.ZONE_ONLY))
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        hold.release()
        u3WaitForNoTag("position-step")
        afterQueuedWrites(rig)
        assertEquals(before + 2, rig.presencePuts(), "the zone-only write and the later write, and no second one")
    }
}
