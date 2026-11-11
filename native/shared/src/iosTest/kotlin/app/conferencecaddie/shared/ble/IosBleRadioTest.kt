package app.conferencecaddie.shared.ble

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import kotlinx.cinterop.BetaInteropApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import platform.CoreBluetooth.CBATTErrorInvalidOffset
import platform.CoreBluetooth.CBATTErrorSuccess
import platform.CoreBluetooth.CBATTErrorUnlikelyError
import platform.CoreBluetooth.CBAdvertisementDataIsConnectable
import platform.CoreBluetooth.CBAdvertisementDataLocalNameKey
import platform.CoreBluetooth.CBAdvertisementDataServiceDataKey
import platform.CoreBluetooth.CBManagerAuthorizationAllowedAlways
import platform.CoreBluetooth.CBManagerAuthorizationDenied
import platform.CoreBluetooth.CBManagerAuthorizationNotDetermined
import platform.CoreBluetooth.CBManagerAuthorizationRestricted
import platform.CoreBluetooth.CBManagerStatePoweredOff
import platform.CoreBluetooth.CBManagerStatePoweredOn
import platform.CoreBluetooth.CBManagerStateResetting
import platform.CoreBluetooth.CBManagerStateUnauthorized
import platform.CoreBluetooth.CBManagerStateUnknown
import platform.CoreBluetooth.CBManagerStateUnsupported
import platform.CoreBluetooth.CBUUID
import platform.Foundation.NSNumber

/**
 * The iOS radio on the simulator, which has no Bluetooth radio: the radio must say so, and asking,
 * starting and stopping must neither hang nor crash. The pure parts (state mapping, read answers,
 * advertisement parsing) are checked here too; [GattReadsTest] checks the read scheduling. What
 * Core Bluetooth itself reports in the simulator is recorded by `-caddie.selftest bleradio` in the
 * app, because a manager needs the app's Info.plist (its usage description and background modes).
 */
class IosBleRadioTest {
    private val radio = IosBleRadio()
    private val config = BleRadioConfig(nearRssi = -75, untilEpochMillis = epochMillis() + 60_000L)

    private class Recorder : BleRadioEvents {
        val stopped = CompletableDeferred<BleStopReason>()
        var heard = 0

        override fun onHeard(payload: ByteArray, rssi: Int, atEpochMillis: Long) {
            heard++
        }

        override fun onStopped(reason: BleStopReason) {
            stopped.complete(reason)
        }
    }

    @Test
    fun theSimulatorHasNoRadio() {
        assertTrue(runningInSimulator(), "the tests run in the simulator")
        assertFalse(radio.supported)
        assertEquals(BlePermissionKind.Bluetooth, radio.permissionKind)
        assertEquals(BleRadioState.Unsupported, radio.state())
        assertFalse(radio.running)
        println("Core Bluetooth authorization in the simulator test process: ${radio.access()}")
    }

    @Test
    fun startStopsAtOnceAsUnsupported() = runBlocking {
        val events = Recorder()
        radio.start(config, { null }, events)
        assertEquals(BleStopReason.Unsupported, withTimeout(5.seconds) { events.stopped.await() })
        assertFalse(radio.running)
        assertEquals(0, events.heard)
    }

    @Test
    fun stopAndRefreshAreSafeWhenNotRunning() = runBlocking {
        radio.stop()
        radio.stop()
        radio.refresh()
        val events = Recorder()
        radio.start(config, { null }, events)
        radio.refresh()
        radio.stop()
        radio.stop()
        withTimeout(5.seconds) { events.stopped.await() }
        assertFalse(radio.running)
    }

    @Test
    fun requestAccessReturnsWithoutAPrompt() = runBlocking {
        val access = withTimeout(5.seconds) { radio.requestAccess() }
        assertEquals(radio.access(), access)
    }

    @Test
    fun theProcessHasOneSharedRadio() {
        assertSame(IosBleRadio.shared, IosBleRadio.shared)
        assertFalse(IosBleRadio.shared.supported)
    }

    @Test
    fun aTestProcessDeclaresNoBackgroundMode() {
        // So a radio created here would never ask Core Bluetooth for state restoration, which ends
        // a process that lacks the mode.
        assertFalse(declaresBackgroundMode("bluetooth-central"))
        assertFalse(declaresBackgroundMode("bluetooth-peripheral"))
    }

    @Test
    fun authorizationsMapToAccess() {
        assertEquals(BleAccess.NotAsked, accessOf(CBManagerAuthorizationNotDetermined))
        assertEquals(BleAccess.Granted, accessOf(CBManagerAuthorizationAllowedAlways))
        assertEquals(BleAccess.Blocked, accessOf(CBManagerAuthorizationDenied))
        assertEquals(BleAccess.Blocked, accessOf(CBManagerAuthorizationRestricted))
    }

    @Test
    fun managerStatesMapToRadioStatesAndStopReasons() {
        assertEquals(BleRadioState.Ready, radioStateOf(CBManagerStatePoweredOn))
        assertEquals(BleRadioState.PoweredOff, radioStateOf(CBManagerStatePoweredOff))
        assertEquals(BleRadioState.Unauthorized, radioStateOf(CBManagerStateUnauthorized))
        assertEquals(BleRadioState.Unsupported, radioStateOf(CBManagerStateUnsupported))
        assertEquals(BleRadioState.Unknown, radioStateOf(CBManagerStateUnknown))
        assertEquals(BleRadioState.Unknown, radioStateOf(CBManagerStateResetting))
        assertNull(stopReasonOf(CBManagerStatePoweredOn))
        assertNull(stopReasonOf(CBManagerStateUnknown))
        assertNull(stopReasonOf(CBManagerStateResetting))
        assertEquals(BleStopReason.BluetoothOff, stopReasonOf(CBManagerStatePoweredOff))
        assertEquals(BleStopReason.PermissionLost, stopReasonOf(CBManagerStateUnauthorized))
        assertEquals(BleStopReason.Unsupported, stopReasonOf(CBManagerStateUnsupported))
    }

    @Test
    fun readsAreAnsweredFromTheirOffset() {
        val payload = ByteArray(BleProtocol.PAYLOAD_V1_BYTES) { (it + 1).toByte() }
        val whole = answerRead(payload, 0)
        assertEquals(CBATTErrorSuccess, whole.result)
        assertContentEquals(payload, whole.value)
        val tail = answerRead(payload, 5)
        assertEquals(CBATTErrorSuccess, tail.result)
        assertContentEquals(payload.copyOfRange(5, payload.size), tail.value)
        val end = answerRead(payload, payload.size.toLong())
        assertEquals(CBATTErrorSuccess, end.result)
        assertEquals(0, end.value!!.size)
        val past = answerRead(payload, payload.size + 1L)
        assertEquals(CBATTErrorInvalidOffset, past.result)
        assertNull(past.value)
        val none = answerRead(null, 0)
        assertEquals(CBATTErrorUnlikelyError, none.result)
        assertNull(none.value)
    }

    @Test
    fun serviceDataIsFoundUnderTheServiceUuid() {
        val payload = byteArrayOf(1, 2, 3, 4)
        val ours = CBUUID.UUIDWithString(BleProtocol.SERVICE_UUID)
        val theirs = CBUUID.UUIDWithString("0000feaa-0000-1000-8000-00805f9b34fb")
        val ad = mapOf<Any?, Any?>(
            CBAdvertisementDataServiceDataKey to mapOf(theirs to byteArrayOf(9).toNSData(), ours to payload.toNSData()),
            CBAdvertisementDataLocalNameKey to "phone",
        )
        // Core Bluetooth writes 128-bit UUIDs in upper case; the contract writes them in lower case.
        assertContentEquals(payload, serviceDataOf(ad, BleProtocol.SERVICE_UUID))
        assertContentEquals(payload, serviceDataOf(ad, BleProtocol.SERVICE_UUID.uppercase()))
        assertNull(serviceDataOf(ad, BleProtocol.TOKEN_CHARACTERISTIC_UUID))
        assertNull(serviceDataOf(mapOf<Any?, Any?>(CBAdvertisementDataLocalNameKey to "phone"), BleProtocol.SERVICE_UUID))
    }

    @OptIn(BetaInteropApi::class)
    @Test
    fun connectableUnlessTheAdvertisementSaysOtherwise() {
        assertTrue(connectableOf(emptyMap<Any?, Any?>()))
        assertTrue(connectableOf(mapOf<Any?, Any?>(CBAdvertisementDataIsConnectable to NSNumber(bool = true))))
        assertFalse(connectableOf(mapOf<Any?, Any?>(CBAdvertisementDataIsConnectable to NSNumber(bool = false))))
        assertFalse(connectableOf(mapOf<Any?, Any?>(CBAdvertisementDataIsConnectable to false)))
    }

    @Test
    fun bytesRoundTripThroughNSData() {
        val bytes = ByteArray(17) { (it * 15).toByte() }
        assertContentEquals(bytes, bytes.toNSData().toByteArray())
        assertEquals(0, ByteArray(0).toNSData().toByteArray().size)
    }
}
