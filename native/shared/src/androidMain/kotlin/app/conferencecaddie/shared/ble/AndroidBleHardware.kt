package app.conferencecaddie.shared.ble

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertisingSet
import android.bluetooth.le.AdvertisingSetCallback
import android.bluetooth.le.AdvertisingSetParameters
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.provider.Settings
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * [BleHardware] on the Android Bluetooth stack, the approach of the Capacitor app's BleService
 * (web/android) extended by the legacy connectable set, the GATT server and interrogation of
 * docs/contracts/ble-tokens.md.
 *
 * - **Advertising.** The extended set is non-connectable and non-scannable with no name and no TX
 *   power, sent once a second at medium power on the 1M PHY (which every Bluetooth 5 phone receives),
 *   carrying the service UUID and the 17-byte payload as service data: 53 bytes, which only an
 *   extended advertisement holds. From Android 14 on, a legacy set is connectable (and therefore
 *   scannable, which a legacy connectable set must be) with the service UUID only, for phones that
 *   cannot receive extended advertisements; they connect and read the characteristic. It is
 *   non-discoverable, so the stack refuses the GAP Device Name to a peer that connected through it
 *   without bonding (and leaves the flags out of it). Before Android 14 the stack lets any connected
 *   peer read that name, which is the name the person gave the phone, so there is no legacy set and
 *   no GATT server ([connectableAdvertising]).
 * - **Scanning.** Two filters (the service UUID, and Apple manufacturer data whose first byte is
 *   0x01, the iOS overflow area), every match reported, legacy and extended advertisements on every
 *   PHY the controller supports, in
 *   SCAN_MODE_BALANCED. Where the controller batches results in hardware, they are delivered every
 *   five seconds, so the application processor sleeps in between. The mode stays the same when the
 *   screen turns off: discovery with the phone in a pocket is the point, restarting a scan to change
 *   its mode counts against Android's limit of five scan starts in 30 seconds, and from Android 13
 *   on the stack itself lowers the duty cycle of a background app's scan while the screen is off.
 * - **Interrogation.** A GATT connection over LE, never automatic, discovery, one read, then
 *   disconnect and close, with a timeout; the device object comes from the scan result, which knows
 *   the address type of a random address.
 *
 * Every Bluetooth call is guarded by a runtime permission check ([granted]) and a SecurityException
 * handler, which is what the lint suppression below stands for. Bluetooth refuses calls with an
 * IllegalStateException while it is switching off; those are reported as [BleHardwareStatus.Off].
 * Nothing here logs an address, a payload or a token.
 */
@SuppressLint("MissingPermission")
class AndroidBleHardware(context: Context) : BleHardware {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val manager: BluetoothManager? = app.getSystemService(BluetoothManager::class.java)
    private val adapter: BluetoothAdapter? get() = manager?.adapter

    private var adapterReceiver: BroadcastReceiver? = null
    private var locationReceiver: BroadcastReceiver? = null

    private var advertiser: BluetoothLeAdvertiser? = null
    private var extendedCallback: AdvertisingSetCallback? = null
    private var legacyCallback: AdvertisingSetCallback? = null

    private var gattServer: BluetoothGattServer? = null

    /** The devices connected to this phone that have asked for the token, by address; written on the GATT binder thread. */
    private val tokenReaders = ConcurrentHashMap<String, BluetoothDevice>()

    private var scanner: BluetoothLeScanner? = null
    private var scanCallback: ScanCallback? = null

    /** The devices of recent scan results by address, for [interrogate]; bounded and cleared on stop. */
    private val recent = object : LinkedHashMap<String, BluetoothDevice>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, BluetoothDevice>?) = size > RECENT_DEVICES
    }

    private var interrogation: Interrogation? = null

    override fun present(): Boolean =
        app.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) && adapter != null

    override fun enabled(): Boolean = adapter?.isEnabled == true

    override fun extendedAdvertisingSupported(): Boolean = adapter?.isLeExtendedAdvertisingSupported == true

    override fun connectableAdvertising(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE

    // --- The adapter -----------------------------------------------------------------------------

    override fun watchAdapter(onOff: () -> Unit) {
        unwatchAdapter()
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
                    BluetoothAdapter.STATE_TURNING_OFF, BluetoothAdapter.STATE_OFF -> onOff()
                }
            }
        }
        val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
        // A system broadcast reaches a receiver that is not exported; before Android 13 the flag
        // does not exist and the receiver only ever acts on the adapter's real state anyway.
        if (Build.VERSION.SDK_INT >= 33) {
            app.registerReceiver(receiver, filter, null, main, Context.RECEIVER_NOT_EXPORTED)
        } else {
            app.registerReceiver(receiver, filter, null, main)
        }
        adapterReceiver = receiver
    }

    override fun unwatchAdapter() {
        val receiver = adapterReceiver ?: return
        adapterReceiver = null
        try {
            app.unregisterReceiver(receiver)
        } catch (e: IllegalArgumentException) {
            // Not registered.
        }
    }

    // --- The Location switch (Android 8 to 11) ----------------------------------------------------

    override fun locationOff(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            app.getSystemService(LocationManager::class.java)?.isLocationEnabled == false
        } else {
            @Suppress("DEPRECATION") // LOCATION_MODE is the only way on Android 8.
            Settings.Secure.getInt(app.contentResolver, Settings.Secure.LOCATION_MODE, Settings.Secure.LOCATION_MODE_OFF) ==
                Settings.Secure.LOCATION_MODE_OFF
        }
    }

    override fun watchLocation(onChange: () -> Unit) {
        unwatchLocation()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) = onChange()
        }
        // A system broadcast; the receiver only ever reads the switch's real state when it arrives.
        app.registerReceiver(receiver, IntentFilter(LocationManager.MODE_CHANGED_ACTION), null, main)
        locationReceiver = receiver
    }

    override fun unwatchLocation() {
        val receiver = locationReceiver ?: return
        locationReceiver = null
        try {
            app.unregisterReceiver(receiver)
        } catch (e: IllegalArgumentException) {
            // Not registered.
        }
    }

    // --- Advertising -----------------------------------------------------------------------------

    override fun startAdvertising(serviceUuid: UUID, payload: ByteArray, onFailed: () -> Unit): BleHardwareStatus {
        stopAdvertising()
        if (!granted(advertisePermission())) return BleHardwareStatus.NoPermission
        val bt = adapter ?: return BleHardwareStatus.Failed
        if (!bt.isEnabled) return BleHardwareStatus.Off
        val adv = bt.bluetoothLeAdvertiser ?: return BleHardwareStatus.Failed
        val uuid = ParcelUuid(serviceUuid)
        val extendedParameters = AdvertisingSetParameters.Builder()
            .setLegacyMode(false)
            .setConnectable(false)
            .setScannable(false)
            .setInterval(AdvertisingSetParameters.INTERVAL_HIGH)
            .setTxPowerLevel(AdvertisingSetParameters.TX_POWER_MEDIUM)
            .setPrimaryPhy(BluetoothDevice.PHY_LE_1M)
            .setSecondaryPhy(BluetoothDevice.PHY_LE_1M)
            .build()
        val extendedData = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addServiceUuid(uuid)
            .addServiceData(uuid, payload)
            .build()
        // Only from Android 14 on (connectableAdvertising), and non-discoverable: the stack then
        // answers a read of the GAP Device Name by a peer that connected through this set without
        // bonding with an error instead of the phone's name.
        val legacyParameters = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            AdvertisingSetParameters.Builder()
                .setLegacyMode(true)
                .setConnectable(true)
                .setScannable(true)
                .setDiscoverable(false)
                .setInterval(AdvertisingSetParameters.INTERVAL_HIGH)
                .setTxPowerLevel(AdvertisingSetParameters.TX_POWER_MEDIUM)
                .build()
        } else {
            null
        }
        val legacyData = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addServiceUuid(uuid)
            .build()
        val emptyResponse = AdvertiseData.Builder().setIncludeDeviceName(false).setIncludeTxPowerLevel(false).build()
        // A callback object of its own for every start: the stack refuses one that is still tied to
        // a set, and a late callback of a stopped set then cannot be mistaken for the new one's.
        // A set whose start was still pending when it was stopped is not stopped by the stack: it
        // starts later anyway, with a token that is no longer current, and nothing would ever stop
        // it. So a set that starts after its callback was replaced stops itself at once.
        val extended = object : AdvertisingSetCallback() {
            override fun onAdvertisingSetStarted(advertisingSet: AdvertisingSet?, txPower: Int, status: Int) {
                if (extendedCallback !== this) {
                    if (advertisingSet != null) stopStale(adv, this)
                    return
                }
                if (status != ADVERTISE_SUCCESS || advertisingSet == null) onFailed()
            }
        }
        val legacy = object : AdvertisingSetCallback() {
            override fun onAdvertisingSetStarted(advertisingSet: AdvertisingSet?, txPower: Int, status: Int) {
                if (legacyCallback !== this && advertisingSet != null) stopStale(adv, this)
            }
        }
        return try {
            adv.startAdvertisingSet(extendedParameters, extendedData, null, null, null, extended)
            advertiser = adv
            extendedCallback = extended
            if (legacyParameters != null) {
                try {
                    adv.startAdvertisingSet(legacyParameters, legacyData, emptyResponse, null, null, legacy)
                    legacyCallback = legacy
                } catch (e: IllegalArgumentException) {
                    // The legacy set is a fallback; the extended set carries the payload on its own.
                }
            }
            BleHardwareStatus.Ok
        } catch (e: SecurityException) {
            stopAdvertising()
            BleHardwareStatus.NoPermission
        } catch (e: IllegalArgumentException) {
            stopAdvertising()
            BleHardwareStatus.Failed
        } catch (e: IllegalStateException) {
            stopAdvertising()
            BleHardwareStatus.Off
        }
    }

    /** Stops a set that started after it had been replaced or stopped (see [startAdvertising]). */
    private fun stopStale(adv: BluetoothLeAdvertiser, callback: AdvertisingSetCallback) {
        try {
            adv.stopAdvertisingSet(callback)
        } catch (e: SecurityException) {
            // Without permission the stack stops advertising for the app anyway.
        } catch (e: IllegalStateException) {
            // Bluetooth is off; the set is gone with it.
        } catch (e: IllegalArgumentException) {
            // Already stopped.
        }
    }

    override fun stopAdvertising() {
        val adv = advertiser
        val callbacks = listOfNotNull(extendedCallback, legacyCallback)
        advertiser = null
        extendedCallback = null
        legacyCallback = null
        if (adv == null) return
        for (callback in callbacks) {
            try {
                adv.stopAdvertisingSet(callback)
            } catch (e: SecurityException) {
                // Already without permission: nothing more to stop.
            } catch (e: IllegalStateException) {
                // Bluetooth is off; the set is gone with it.
            } catch (e: IllegalArgumentException) {
                // The set never started.
            }
        }
    }

    // --- GATT server ------------------------------------------------------------------------------

    override fun openGattServer(serviceUuid: UUID, characteristicUuid: UUID, reader: BleCharacteristicReader): BleHardwareStatus {
        closeGattServer()
        if (!granted(connectPermission())) return BleHardwareStatus.NoPermission
        val bt = adapter ?: return BleHardwareStatus.Failed
        if (!bt.isEnabled) return BleHardwareStatus.Off
        val btManager = manager ?: return BleHardwareStatus.Failed
        var server: BluetoothGattServer? = null
        val callback = object : BluetoothGattServerCallback() {
            // Called for every LE connection of the phone (a bonded watch's too), not only for those
            // that read the token; only the readers are known to the reader and ever disconnected.
            override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
                if (newState != BluetoothProfile.STATE_DISCONNECTED) return
                tokenReaders.remove(device.address)
                reader.disconnected(device.address)
            }

            override fun onCharacteristicReadRequest(
                device: BluetoothDevice,
                requestId: Int,
                offset: Int,
                characteristic: BluetoothGattCharacteristic,
            ) {
                val answer = if (characteristic.uuid == characteristicUuid) {
                    tokenReaders[device.address] = device
                    reader.read(device.address, offset)
                } else {
                    BleGattAnswer(BluetoothGatt.GATT_READ_NOT_PERMITTED, null)
                }
                try {
                    server?.sendResponse(device, requestId, answer.status, offset, answer.value)
                } catch (e: SecurityException) {
                    // The permission went away; the reader gets no answer and times out.
                } catch (e: IllegalStateException) {
                    // Bluetooth is switching off.
                }
            }
        }
        return try {
            val opened = btManager.openGattServer(app, callback) ?: return BleHardwareStatus.Failed
            server = opened
            val service = BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
            service.addCharacteristic(
                BluetoothGattCharacteristic(
                    characteristicUuid,
                    BluetoothGattCharacteristic.PROPERTY_READ,
                    BluetoothGattCharacteristic.PERMISSION_READ,
                ),
            )
            gattServer = opened
            if (opened.addService(service)) BleHardwareStatus.Ok else {
                closeGattServer()
                BleHardwareStatus.Failed
            }
        } catch (e: SecurityException) {
            closeGattServer()
            BleHardwareStatus.NoPermission
        } catch (e: IllegalStateException) {
            closeGattServer()
            BleHardwareStatus.Off
        }
    }

    override fun disconnectGattClients(devices: Collection<String>) {
        val server = gattServer ?: return
        for (address in devices) {
            val device = tokenReaders[address] ?: continue
            try {
                server.cancelConnection(device)
            } catch (e: SecurityException) {
                // Without the permission nothing more can be done; the reader refuses its reads.
            } catch (e: IllegalStateException) {
                // Bluetooth is switching off, which ends the connection anyway.
            }
        }
    }

    override fun closeGattServer() {
        tokenReaders.clear()
        val server = gattServer ?: return
        gattServer = null
        try {
            server.close()
        } catch (e: SecurityException) {
            // Nothing more to close without the permission.
        } catch (e: IllegalStateException) {
            // Bluetooth is off.
        }
    }

    // --- Scanning ---------------------------------------------------------------------------------

    override fun startScan(serviceUuid: UUID, listener: BleScanListener): BleHardwareStatus {
        // A restart keeps the devices of recent results, which a pending interrogation still needs.
        stopScanning(forget = false)
        if (!granted(scanPermission())) return BleHardwareStatus.NoPermission
        val bt = adapter ?: return BleHardwareStatus.Failed
        if (!bt.isEnabled) return BleHardwareStatus.Off
        val sc = bt.bluetoothLeScanner ?: return BleHardwareStatus.Failed
        val uuid = ParcelUuid(serviceUuid)
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_BALANCED)
            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            .setLegacy(false)
            .setPhy(ScanSettings.PHY_LE_ALL_SUPPORTED)
            .apply { if (bt.isOffloadedScanBatchingSupported) setReportDelay(BATCH_MS) }
            .build()
        val filters = listOf(
            ScanFilter.Builder().setServiceUuid(uuid).build(),
            // Only Apple data whose first byte is the overflow type: an iPhone advertising an app's
            // service in the background. Its other advertisements (AirPods, watches, Macs, and the
            // iPhone's own routine ones) would wake the scan for nothing.
            ScanFilter.Builder()
                .setManufacturerData(
                    BleInterrogation.APPLE_COMPANY_ID,
                    byteArrayOf(BleInterrogation.APPLE_OVERFLOW_TYPE),
                    byteArrayOf(-1),
                )
                .build(),
        )
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                if (scanCallback !== this) return
                listener.onAdvertisements(listOf(advertisement(result, uuid)))
            }

            override fun onBatchScanResults(results: MutableList<ScanResult>) {
                if (scanCallback !== this || results.isEmpty()) return
                listener.onAdvertisements(results.map { advertisement(it, uuid) })
            }

            override fun onScanFailed(errorCode: Int) {
                if (scanCallback !== this) return
                scanCallback = null
                scanner = null
                listener.onScanFailed()
            }
        }
        return try {
            sc.startScan(filters, settings, callback)
            scanner = sc
            scanCallback = callback
            BleHardwareStatus.Ok
        } catch (e: SecurityException) {
            BleHardwareStatus.NoPermission
        } catch (e: IllegalStateException) {
            BleHardwareStatus.Off
        } catch (e: IllegalArgumentException) {
            BleHardwareStatus.Failed
        }
    }

    override fun stopScan() = stopScanning(forget = true)

    private fun stopScanning(forget: Boolean) {
        val sc = scanner
        val callback = scanCallback
        scanner = null
        scanCallback = null
        if (forget) recent.clear()
        if (sc == null || callback == null) return
        try {
            sc.stopScan(callback)
        } catch (e: SecurityException) {
            // Nothing to do.
        } catch (e: IllegalStateException) {
            // Bluetooth is off.
        }
    }

    private fun advertisement(result: ScanResult, uuid: ParcelUuid): BleAdvertisement {
        val record = result.scanRecord
        val address = result.device.address
        recent[address] = result.device
        return BleAdvertisement(
            address = address,
            rssi = result.rssi,
            serviceData = record?.getServiceData(uuid),
            advertisesService = record?.serviceUuids?.contains(uuid) == true,
            appleData = record?.getManufacturerSpecificData(BleInterrogation.APPLE_COMPANY_ID),
            connectable = result.isConnectable,
        )
    }

    // --- Interrogation ----------------------------------------------------------------------------

    /** One connection in progress; [finish] runs once, on the main thread. */
    private inner class Interrogation(
        val serviceUuid: UUID,
        val characteristicUuid: UUID,
        val done: (BleReadResult) -> Unit,
    ) : BluetoothGattCallback() {
        var gatt: BluetoothGatt? = null
        private var finished = false
        val timeout = Runnable { finish(BleReadResult.Failed) }

        fun finish(result: BleReadResult, report: Boolean = true) {
            if (finished) return
            finished = true
            main.removeCallbacks(timeout)
            if (interrogation === this) interrogation = null
            gatt?.let { g ->
                try {
                    g.disconnect()
                    g.close()
                } catch (e: SecurityException) {
                    // Without the permission there is no connection left to close.
                }
            }
            gatt = null
            if (report) done(result)
        }

        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (finished) return
            if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                val started = try {
                    g.discoverServices()
                } catch (e: SecurityException) {
                    finish(BleReadResult.NoPermission)
                    return
                }
                if (!started) finish(BleReadResult.Failed)
            } else {
                finish(BleReadResult.Failed)
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (finished) return
            if (status != BluetoothGatt.GATT_SUCCESS) {
                finish(BleReadResult.Failed)
                return
            }
            val characteristic = g.getService(serviceUuid)?.getCharacteristic(characteristicUuid)
            if (characteristic == null) {
                finish(BleReadResult.NotFound)
                return
            }
            val started = try {
                g.readCharacteristic(characteristic)
            } catch (e: SecurityException) {
                finish(BleReadResult.NoPermission)
                return
            }
            if (!started) finish(BleReadResult.Failed)
        }

        // Android 13 and newer call this one with the value.
        override fun onCharacteristicRead(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
            read(value, status)
        }

        // Android 12 and older call this one; the value is on the characteristic.
        @Deprecated("Deprecated in Android 13")
        override fun onCharacteristicRead(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            @Suppress("DEPRECATION")
            read(characteristic.value, status)
        }

        private fun read(value: ByteArray?, status: Int) {
            if (finished) return
            finish(if (status == BluetoothGatt.GATT_SUCCESS && value != null) BleReadResult.Value(value.copyOf()) else BleReadResult.Failed)
        }
    }

    override fun interrogate(
        address: String,
        serviceUuid: UUID,
        characteristicUuid: UUID,
        timeoutMillis: Long,
        done: (BleReadResult) -> Unit,
    ) {
        cancelInterrogation()
        if (!granted(connectPermission())) {
            main.post { done(BleReadResult.NoPermission) }
            return
        }
        val bt = adapter
        val device = recent[address] ?: try {
            bt?.getRemoteDevice(address)
        } catch (e: IllegalArgumentException) {
            null
        }
        if (bt == null || device == null || !bt.isEnabled) {
            main.post { done(BleReadResult.Failed) }
            return
        }
        val job = Interrogation(serviceUuid, characteristicUuid, done)
        interrogation = job
        main.postDelayed(job.timeout, timeoutMillis)
        try {
            // Callbacks on the main thread, like everything else here. The replacement of this call
            // (with BluetoothGattConnectionSettings) only exists from API 37; this one works from 26.
            @Suppress("DEPRECATION")
            job.gatt = device.connectGatt(app, false, job, BluetoothDevice.TRANSPORT_LE, BluetoothDevice.PHY_LE_1M_MASK, main)
            if (job.gatt == null) main.post { job.finish(BleReadResult.Failed) }
        } catch (e: SecurityException) {
            main.post { job.finish(BleReadResult.NoPermission) }
        } catch (e: IllegalStateException) {
            main.post { job.finish(BleReadResult.Failed) }
        }
    }

    override fun cancelInterrogation() {
        interrogation?.finish(BleReadResult.Failed, report = false)
        interrogation = null
    }

    // --- Permissions ------------------------------------------------------------------------------

    private fun granted(permission: String?): Boolean =
        permission == null || app.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private companion object {
        /** Hardware batching delay for the scanner, where the controller supports it. */
        const val BATCH_MS = 5_000L

        /** Scan results whose device objects are kept for a connection. */
        const val RECENT_DEVICES = 256

        // Android 12 and newer have a runtime permission for each; before, BLUETOOTH and
        // BLUETOOTH_ADMIN are granted at install and scanning needs the location permission.
        fun advertisePermission(): String? = if (Build.VERSION.SDK_INT >= 31) Manifest.permission.BLUETOOTH_ADVERTISE else null

        fun connectPermission(): String? = if (Build.VERSION.SDK_INT >= 31) Manifest.permission.BLUETOOTH_CONNECT else null

        fun scanPermission(): String =
            if (Build.VERSION.SDK_INT >= 31) Manifest.permission.BLUETOOTH_SCAN else Manifest.permission.ACCESS_FINE_LOCATION
    }
}
