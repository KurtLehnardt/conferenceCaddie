package app.conferencecaddie

import app.conferencecaddie.shared.ble.BleAdvertisement
import app.conferencecaddie.shared.ble.BleCharacteristicReader
import app.conferencecaddie.shared.ble.BleHardware
import app.conferencecaddie.shared.ble.BleHardwareStatus
import app.conferencecaddie.shared.ble.BleReadResult
import app.conferencecaddie.shared.ble.BleScanListener
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

/**
 * A [BleHardware] that records what the service asks of the Bluetooth stack and lets a test play the
 * stack's part (an advertisement heard, a read answered, Bluetooth switched off). The emulator's
 * Bluetooth is virtual, so the service's behaviour is checked against this instead. The service calls
 * it on the main thread, and the test calls the listeners it captured on the main thread too.
 */
class FakeBleHardware : BleHardware {
    @Volatile var present = true
    @Volatile var enabled = true
    @Volatile var extended = true
    @Volatile var connectable = true
    @Volatile var locationOff = false
    @Volatile var advertiseStatus = BleHardwareStatus.Ok
    @Volatile var scanStatus = BleHardwareStatus.Ok

    /** Every payload advertising was started with, in order. */
    val advertised = CopyOnWriteArrayList<ByteArray>()

    /** Every call to start advertising, refused ones included. */
    @Volatile var advertiseAttempts = 0

    /** The payload being advertised now, or null when advertising is stopped. */
    @Volatile var advertising: ByteArray? = null
    @Volatile var advertisingUuid: UUID? = null
    @Volatile var onAdvertiseFailed: (() -> Unit)? = null

    @Volatile var reader: BleCharacteristicReader? = null
    @Volatile var gattUuids: Pair<UUID, UUID>? = null
    @Volatile var gattOpens = 0

    /** Every device whose connection the service ended, in order. */
    val disconnectedClients = CopyOnWriteArrayList<String>()

    @Volatile var scanListener: BleScanListener? = null
    @Volatile var scanStarts = 0

    @Volatile var onAdapterOff: (() -> Unit)? = null
    @Volatile var onLocationChange: (() -> Unit)? = null

    /** Every address the service connected to, in order. */
    val interrogated = CopyOnWriteArrayList<String>()
    @Volatile var pendingRead: ((BleReadResult) -> Unit)? = null

    override fun present() = present

    override fun enabled() = enabled

    override fun extendedAdvertisingSupported() = extended

    override fun connectableAdvertising() = connectable

    override fun locationOff() = locationOff

    override fun watchLocation(onChange: () -> Unit) {
        onLocationChange = onChange
    }

    override fun unwatchLocation() {
        onLocationChange = null
    }

    override fun watchAdapter(onOff: () -> Unit) {
        onAdapterOff = onOff
    }

    override fun unwatchAdapter() {
        onAdapterOff = null
    }

    override fun startAdvertising(serviceUuid: UUID, payload: ByteArray, onFailed: () -> Unit): BleHardwareStatus {
        advertiseAttempts++
        if (advertiseStatus != BleHardwareStatus.Ok) return advertiseStatus
        advertised += payload.copyOf()
        advertising = payload.copyOf()
        advertisingUuid = serviceUuid
        onAdvertiseFailed = onFailed
        return BleHardwareStatus.Ok
    }

    override fun stopAdvertising() {
        advertising = null
        onAdvertiseFailed = null
    }

    override fun openGattServer(serviceUuid: UUID, characteristicUuid: UUID, reader: BleCharacteristicReader): BleHardwareStatus {
        this.reader = reader
        gattUuids = serviceUuid to characteristicUuid
        gattOpens++
        return BleHardwareStatus.Ok
    }

    override fun disconnectGattClients(devices: Collection<String>) {
        disconnectedClients += devices
    }

    override fun closeGattServer() {
        reader = null
        gattUuids = null
    }

    override fun startScan(serviceUuid: UUID, listener: BleScanListener): BleHardwareStatus {
        scanStarts++
        if (scanStatus != BleHardwareStatus.Ok) {
            scanListener = null
            return scanStatus
        }
        scanListener = listener
        return BleHardwareStatus.Ok
    }

    override fun stopScan() {
        scanListener = null
    }

    override fun interrogate(address: String, serviceUuid: UUID, characteristicUuid: UUID, timeoutMillis: Long, done: (BleReadResult) -> Unit) {
        interrogated += address
        pendingRead = done
    }

    override fun cancelInterrogation() {
        pendingRead = null
    }

    /** Whether everything the service started is stopped again. */
    val idle: Boolean
        get() = advertising == null && reader == null && scanListener == null && onAdapterOff == null && onLocationChange == null &&
            pendingRead == null

    companion object {
        /** An advertisement as the scan would report it. */
        fun ad(
            address: String,
            rssi: Int,
            serviceData: ByteArray? = null,
            advertisesService: Boolean = false,
            appleData: ByteArray? = null,
            connectable: Boolean = true,
        ) = BleAdvertisement(address, rssi, serviceData, advertisesService, appleData, connectable)
    }
}
