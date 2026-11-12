package app.conferencecaddie.shared.ble

import java.util.UUID

/**
 * Every call [BleRadioService] makes into the Android Bluetooth stack, behind one interface, so the
 * instrumented tests can run the service's whole life against a fake: an emulator's Bluetooth is
 * virtual and nothing about real radios can be asserted on it. [AndroidBleHardware] is the real one.
 *
 * The service calls everything on the main thread, and every listener is called back on the main
 * thread too, except [BleCharacteristicReader], which a GATT server calls from its binder thread.
 * Starting something that is already started replaces it; stopping something that is not started
 * does nothing.
 */
interface BleHardware {
    /** The device has Bluetooth LE and an adapter. */
    fun present(): Boolean

    /** The adapter is switched on. */
    fun enabled(): Boolean

    /** The controller can send Bluetooth 5 extended advertisements; only known while [enabled]. */
    fun extendedAdvertisingSupported(): Boolean

    /**
     * Whether this phone offers the legacy connectable advertising set and the GATT server behind
     * it. Only from Android 14 (API 34) on, where the set can be made non-discoverable, so the stack
     * refuses the GAP Device Name (the name the person gave the phone) to a peer that connects
     * without bonding. Before, any phone that connects can read that name, so the set and the server
     * are not offered at all, and the phone is found only through its extended advertisement.
     */
    fun connectableAdvertising(): Boolean

    /** Calls [onOff] when the adapter starts switching off, until [unwatchAdapter]. */
    fun watchAdapter(onOff: () -> Unit)

    /** Stops calling the `onOff` of [watchAdapter]. */
    fun unwatchAdapter()

    /**
     * Android 8 to 11: the Location switch is off, so a scan hears nothing (the stack drops every
     * result). Always false from Android 12 on, where a scan declared `neverForLocation` needs no
     * location at all.
     */
    fun locationOff(): Boolean

    /** Calls [onChange] whenever the Location switch changes, until [unwatchLocation]; nothing from Android 12 on. */
    fun watchLocation(onChange: () -> Unit)

    /** Stops calling the `onChange` of [watchLocation]. */
    fun unwatchLocation()

    /**
     * Starts both advertising sets with [payload] (docs/contracts/ble-tokens.md, Over the air): the
     * extended, non-connectable, non-scannable set with [serviceUuid] and the payload as its service
     * data, and, where [connectableAdvertising] allows it, the legacy connectable set with
     * [serviceUuid] only. A failure of the extended set after it was accepted arrives at [onFailed];
     * the legacy set is a fallback for phones that cannot receive extended advertisements, and its
     * failure is not reported.
     */
    fun startAdvertising(serviceUuid: UUID, payload: ByteArray, onFailed: () -> Unit): BleHardwareStatus

    /** Stops both advertising sets. */
    fun stopAdvertising()

    /**
     * Opens a GATT server with the primary service [serviceUuid] and its read-only characteristic
     * [characteristicUuid], answering every read of it with [reader] and telling [reader] when a
     * connected device goes away.
     */
    fun openGattServer(serviceUuid: UUID, characteristicUuid: UUID, reader: BleCharacteristicReader): BleHardwareStatus

    /**
     * Ends the connections of [devices] (addresses that [BleCharacteristicReader.read] named) to this
     * phone. Devices that are not connected are skipped.
     */
    fun disconnectGattClients(devices: Collection<String>)

    /** Closes the GATT server, which ends the connections of phones reading it. */
    fun closeGattServer()

    /**
     * Scans for advertisements with [serviceUuid] or with Apple manufacturer data of the iOS overflow
     * area (first byte 0x01), and hands them to [listener] (in batches where the controller batches).
     * Starting again while a scan runs restarts it.
     */
    fun startScan(serviceUuid: UUID, listener: BleScanListener): BleHardwareStatus

    /** Stops the scan; its listener hears nothing more. */
    fun stopScan()

    /**
     * Connects to [address] (an address from a scan result), looks for [serviceUuid], reads
     * [characteristicUuid] and disconnects, giving up after [timeoutMillis]. [done] is called exactly
     * once, unless [cancelInterrogation] is called first. One at a time.
     */
    fun interrogate(address: String, serviceUuid: UUID, characteristicUuid: UUID, timeoutMillis: Long, done: (BleReadResult) -> Unit)

    /** Ends the interrogation in progress, if any, without calling its `done`. */
    fun cancelInterrogation()
}

/** How a call into the stack went. */
enum class BleHardwareStatus {
    /** Done, or under way with any later failure reported through the call's listener. */
    Ok,

    /** A permission it needs is not granted (or was revoked). */
    NoPermission,

    /** Bluetooth is off or turning off. */
    Off,

    /** The stack refused for another reason. */
    Failed,
}

/** Answers reads of the token characteristic. Called from a binder thread; must be thread-safe and fast. */
interface BleCharacteristicReader {
    /**
     * The answer to a read by [device] (its address on this connection, the key of
     * [BleHardware.disconnectGattClients]) at [offset] into the value.
     */
    fun read(device: String, offset: Int): BleGattAnswer

    /** [device]'s connection to this phone ended. */
    fun disconnected(device: String)
}

/** A GATT read answer: the ATT status and, on success, the value from the requested offset on. */
class BleGattAnswer(
    /** The ATT status, one of the BluetoothGatt constants below. */
    val status: Int,
    /** The bytes to send, from the requested offset on; null with an error status. */
    val value: ByteArray?,
) {
    companion object {
        /** BluetoothGatt.GATT_SUCCESS. */
        const val SUCCESS = 0

        /** BluetoothGatt.GATT_READ_NOT_PERMITTED: this connection may not read the value now. */
        const val READ_NOT_PERMITTED = 0x2

        /** BluetoothGatt.GATT_INVALID_OFFSET. */
        const val INVALID_OFFSET = 0x7

        /** BluetoothGatt.GATT_FAILURE: there is no payload to serve right now. */
        const val FAILURE = 0x101

        /**
         * The answer for a read of [payload] at [offset]: the bytes from [offset] on, nothing at the
         * end of the value, an invalid offset past it, and a failure when there is no payload.
         */
        fun of(payload: ByteArray?, offset: Int): BleGattAnswer = when {
            payload == null -> BleGattAnswer(FAILURE, null)
            offset < 0 || offset > payload.size -> BleGattAnswer(INVALID_OFFSET, null)
            else -> BleGattAnswer(SUCCESS, payload.copyOfRange(offset, payload.size))
        }
    }
}

/** One advertisement a scan received, reduced to what the radio uses. */
class BleAdvertisement(
    /** The advertiser's Bluetooth address, the key of [BleHardware.interrogate]. */
    val address: String,
    /** The received signal strength in dBm. */
    val rssi: Int,
    /** The service data for the service UUID, or null. */
    val serviceData: ByteArray?,
    /** The service UUID is in the advertisement's list of service UUIDs. */
    val advertisesService: Boolean,
    /** Apple's manufacturer data (company 0x004C) without the company identifier, or null. */
    val appleData: ByteArray?,
    /** The advertisement accepts connections. */
    val connectable: Boolean,
)

/** Receives what a scan finds. */
interface BleScanListener {
    /** Advertisements received since the last call: one, or a batch where the controller batches. */
    fun onAdvertisements(advertisements: List<BleAdvertisement>)

    /** The scan could not start or stopped with an error; advertising goes on without it. */
    fun onScanFailed()
}

/** What [BleHardware.interrogate] found. */
sealed interface BleReadResult {
    /** The characteristic's value. */
    class Value(
        /** The value read, as the device served it. */
        val bytes: ByteArray,
    ) : BleReadResult

    /** Connected, but the device has no such service or characteristic. */
    data object NotFound : BleReadResult

    /** No connection, a timeout, a dropped link or a failed read. */
    data object Failed : BleReadResult

    /** The connect permission is missing. */
    data object NoPermission : BleReadResult
}
