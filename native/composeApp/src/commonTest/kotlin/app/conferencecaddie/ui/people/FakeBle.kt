package app.conferencecaddie.ui.people

import app.conferencecaddie.shared.Notifier
import app.conferencecaddie.shared.ble.BleAccess
import app.conferencecaddie.shared.ble.BlePayloadSource
import app.conferencecaddie.shared.ble.BlePermissionKind
import app.conferencecaddie.shared.ble.BleRadio
import app.conferencecaddie.shared.ble.BleRadioConfig
import app.conferencecaddie.shared.ble.BleRadioEvents
import app.conferencecaddie.shared.ble.BleRadioState
import app.conferencecaddie.shared.ble.BleStopReason
import kotlin.concurrent.Volatile
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

// Bluetooth stand-ins for the UI tests: a radio without hardware and a notifier that only records.
// The shared module's own fakes live in its commonTest, which composeApp's tests cannot see.

/**
 * A Bluetooth radio for the UI tests: the permission and the radio's state are what the test sets,
 * starts and stops are counted, and [stopBySelf] plays the radio stopping on its own. Set [prompt]
 * to hold [requestAccess] (the system prompt) open until the test completes it. The controller
 * calls it from its own thread, so everything the test reads is volatile.
 */
internal class FakeUiBleRadio(override val permissionKind: BlePermissionKind = BlePermissionKind.NearbyDevices) : BleRadio {
    override val supported: Boolean = true

    /** The permission before any prompt. */
    @Volatile
    var access: BleAccess = BleAccess.Granted

    /** The permission once the prompt is answered. */
    @Volatile
    var afterRequest: BleAccess = BleAccess.Granted

    @Volatile
    var radioState: BleRadioState = BleRadioState.Ready

    /** While set, the system prompt stays up until it completes. */
    @Volatile
    var prompt: CompletableDeferred<Unit>? = null

    @Volatile
    override var running: Boolean = false

    /** How often the prompt showed, the radio started and it was stopped. */
    val requests = MutableStateFlow(0)
    val starts = MutableStateFlow(0)
    val stops = MutableStateFlow(0)

    @Volatile
    private var events: BleRadioEvents? = null

    override fun access(): BleAccess = access

    override suspend fun requestAccess(): BleAccess {
        requests.update { it + 1 }
        prompt?.await()
        access = afterRequest
        return access
    }

    override fun state(): BleRadioState = radioState

    override fun start(config: BleRadioConfig, source: BlePayloadSource, events: BleRadioEvents) {
        this.events = events
        running = true
        starts.update { it + 1 }
    }

    override fun refresh() = Unit

    override fun stop() {
        running = false
        stops.update { it + 1 }
    }

    /** The radio stops by itself for [reason], as when Bluetooth is switched off on the phone. */
    fun stopBySelf(reason: BleStopReason) {
        running = false
        events?.onStopped(reason)
    }
}

/** A notifier whose permission is [allowed]; [shown] holds the bodies of the notifications shown. */
internal class FakeNotifier(@Volatile var allowed: Boolean = true) : Notifier {
    val shown = MutableStateFlow<List<String>>(emptyList())

    override suspend fun requestPermission(): Boolean = allowed

    override fun show(id: String, title: String, body: String, deepLink: String?) {
        shown.update { it + body }
    }

    override fun cancel(id: String) = Unit
}
