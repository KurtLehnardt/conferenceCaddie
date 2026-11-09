package app.conferencecaddie.ble

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
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
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.conferencecaddie.R

/**
 * The foreground service behind "Find people near me by Bluetooth".
 *
 * While it runs, the phone advertises the Caddie service UUID with the current 16-byte token as
 * service data (BLE 5 extended advertising, non-connectable, non-scannable, low duty cycle) and,
 * when asked to, scans for the same UUID in SCAN_MODE_BALANCED with hardware batching where the
 * chip supports it. Every 10 seconds the tokens heard in that window are handed to the plugin,
 * deduped per token with the strongest RSSI. Nothing is stored and nothing is sent anywhere from
 * here: the plugin forwards the window to the web app, which reports it to the server.
 *
 * The persistent notification says "Conference Caddie is finding people near you" and carries a
 * Stop action. The service stops by itself after the duration it was started with (the remaining
 * presence time), when Bluetooth turns off, when advertising fails, or when the app says stop.
 *
 * The 16-byte token together with a 128-bit service UUID does not fit the 31-byte legacy
 * advertisement (2 + 16 + 16 = 34 bytes of service data), so the extended advertising of
 * Bluetooth 5 is used. A phone whose chip lacks it cannot take part; the plugin reports that.
 *
 * Every Bluetooth call is guarded by a runtime permission check (granted()) and a SecurityException
 * handler, which is what the lint suppression below stands for.
 */
@SuppressLint("MissingPermission")
class BleService : Service() {

    interface Sink {
        fun onSightings(sightings: List<Sighting>)
        fun onStopped(reason: String)
    }

    data class Sighting(val token: String, val rssi: Int)

    companion object {
        const val ACTION_START = "app.conferencecaddie.ble.START"
        const val ACTION_ROTATE = "app.conferencecaddie.ble.ROTATE"
        const val ACTION_STOP = "app.conferencecaddie.ble.STOP"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_SCAN = "scan"
        const val EXTRA_DURATION_MS = "duration_ms"

        /** Set by the plugin while it is loaded; called on the main thread. */
        @Volatile
        var sink: Sink? = null

        @Volatile
        var running: Boolean = false
            private set

        fun start(context: Context, token: ByteArray, scan: Boolean, durationMs: Long) {
            val intent = Intent(context, BleService::class.java).setAction(ACTION_START)
                .putExtra(EXTRA_TOKEN, token)
                .putExtra(EXTRA_SCAN, scan)
                .putExtra(EXTRA_DURATION_MS, durationMs)
            ContextCompat.startForegroundService(context, intent)
        }

        fun rotate(context: Context, token: ByteArray, durationMs: Long?) {
            val intent = Intent(context, BleService::class.java).setAction(ACTION_ROTATE)
                .putExtra(EXTRA_TOKEN, token)
            if (durationMs != null) intent.putExtra(EXTRA_DURATION_MS, durationMs)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, BleService::class.java))
        }

        fun encodeToken(bytes: ByteArray): String =
            Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

        /** The 16 bytes of a base64url token, or null when it is not one. */
        fun decodeToken(token: String?): ByteArray? {
            if (token == null || token.length != BleConstants.TOKEN_BASE64URL_LENGTH) return null
            if (!token.all { it.isLetterOrDigit() || it == '-' || it == '_' }) return null
            val bytes = try {
                Base64.decode(token, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
            } catch (e: IllegalArgumentException) {
                return null
            }
            return if (bytes.size == BleConstants.TOKEN_BYTES) bytes else null
        }

        fun ensureChannels(context: Context) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(
                NotificationChannel(
                    BleConstants.CHANNEL_PRESENCE,
                    context.getString(R.string.ble_channel_presence),
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = context.getString(R.string.ble_channel_presence_desc)
                    setShowBadge(false)
                },
            )
            manager.createNotificationChannel(
                NotificationChannel(
                    BleConstants.CHANNEL_NEARBY,
                    context.getString(R.string.ble_channel_nearby),
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply { description = context.getString(R.string.ble_channel_nearby_desc) },
            )
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private val serviceUuid = ParcelUuid(BleConstants.SERVICE_UUID)

    private var adapter: BluetoothAdapter? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var advertisingSet: AdvertisingSet? = null
    private var scanner: BluetoothLeScanner? = null
    private var scanning = false
    private var stopReason: String? = null

    /** token -> strongest RSSI heard in the current window. */
    private val window = HashMap<String, Int>()

    private val flush = object : Runnable {
        override fun run() {
            if (window.isNotEmpty()) {
                val list = window.entries
                    .sortedByDescending { it.value }
                    .take(BleConstants.MAX_SIGHTINGS)
                    .map { Sighting(it.key, it.value) }
                window.clear()
                sink?.onSightings(list)
            }
            handler.postDelayed(this, BleConstants.WINDOW_MS)
        }
    }

    private val expire = Runnable { stopWith("expired") }
    private val stale = Runnable { stopWith("stale") }

    private val advertisingCallback = object : AdvertisingSetCallback() {
        override fun onAdvertisingSetStarted(set: AdvertisingSet?, txPower: Int, status: Int) {
            if (status != ADVERTISE_SUCCESS || set == null) {
                stopWith("advertise_failed_$status")
                return
            }
            advertisingSet = set
        }

        override fun onAdvertisingSetStopped(set: AdvertisingSet?) {
            advertisingSet = null
        }

        override fun onAdvertisingDataSet(set: AdvertisingSet?, status: Int) {
            if (status != ADVERTISE_SUCCESS) stopWith("rotate_failed_$status")
        }
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            record(result)
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
            results.forEach { record(it) }
        }

        override fun onScanFailed(errorCode: Int) {
            // Advertising still works without scanning, so the service keeps going; the other
            // phone's scan can still find this one. ALREADY_STARTED is a stale scan and harmless.
            scanning = false
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannels(this)
        adapter = (getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Every path through here is a foreground start, so startForeground always comes first.
        startInForeground()
        if (intent == null) {
            if (!running) stopWith("not_running")
            return START_NOT_STICKY
        }
        when (intent.action) {
            ACTION_START -> {
                val token = intent.getByteArrayExtra(EXTRA_TOKEN)
                val duration = intent.getLongExtra(EXTRA_DURATION_MS, 0L)
                if (token == null || token.size != BleConstants.TOKEN_BYTES || duration <= 0L) {
                    stopWith("bad_request")
                    return START_NOT_STICKY
                }
                running = true
                stopReason = null
                schedule(duration)
                freshen()
                if (!startAdvertising(token)) return START_NOT_STICKY
                if (intent.getBooleanExtra(EXTRA_SCAN, true)) startScanning()
                handler.removeCallbacks(flush)
                handler.postDelayed(flush, BleConstants.WINDOW_MS)
            }
            ACTION_ROTATE -> {
                val token = intent.getByteArrayExtra(EXTRA_TOKEN)
                if (!running || token == null || token.size != BleConstants.TOKEN_BYTES) {
                    if (!running) stopWith("not_running")
                    return START_NOT_STICKY
                }
                if (intent.hasExtra(EXTRA_DURATION_MS)) schedule(intent.getLongExtra(EXTRA_DURATION_MS, 0L))
                freshen()
                rotateAdvertising(token)
            }
            ACTION_STOP -> stopWith("user")
            else -> if (!running) stopWith("not_running")
        }
        // Never restarted by the system on its own: a restart would advertise a stale token.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        stopScanning()
        stopAdvertising()
        window.clear()
        val wasRunning = running
        running = false
        if (wasRunning) sink?.onStopped(stopReason ?: "stopped")
        super.onDestroy()
    }

    // --- Lifecycle -----------------------------------------------------------------------------

    private fun schedule(durationMs: Long) {
        handler.removeCallbacks(expire)
        if (durationMs > 0L) handler.postDelayed(expire, durationMs)
    }

    /** A fresh token arrived: the stale timer starts over. */
    private fun freshen() {
        handler.removeCallbacks(stale)
        handler.postDelayed(stale, BleConstants.STALE_MS)
    }

    private fun stopWith(reason: String) {
        if (stopReason == null) stopReason = reason
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun startInForeground() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(
                this,
                BleConstants.NOTIFICATION_PRESENCE,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else {
            startForeground(BleConstants.NOTIFICATION_PRESENCE, notification)
        }
    }

    private fun buildNotification(): Notification {
        val stopIntent = Intent(this, BleService::class.java).setAction(ACTION_STOP)
        val stopPending = PendingIntent.getForegroundService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val openIntent = packageManager.getLaunchIntentForPackage(packageName)
        val openPending = openIntent?.let {
            PendingIntent.getActivity(this, 2, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        return NotificationCompat.Builder(this, BleConstants.CHANNEL_PRESENCE)
            .setSmallIcon(R.drawable.ic_stat_caddie)
            .setContentTitle(getString(R.string.ble_foreground_title))
            .setContentText(getString(R.string.ble_foreground_text))
            .setStyle(NotificationCompat.BigTextStyle().bigText(getString(R.string.ble_foreground_text)))
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .apply { if (openPending != null) setContentIntent(openPending) }
            .addAction(0, getString(R.string.ble_stop), stopPending)
            .build()
    }

    // --- Advertising ---------------------------------------------------------------------------

    private fun advertiseData(token: ByteArray): AdvertiseData =
        AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addServiceUuid(serviceUuid)
            .addServiceData(serviceUuid, token)
            .build()

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    /** Starts advertising the token. Returns false (and stops the service) when it cannot. */
    private fun startAdvertising(token: ByteArray): Boolean {
        val bt = adapter
        if (bt == null) return fail("bluetooth_unavailable")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !granted(Manifest.permission.BLUETOOTH_ADVERTISE)) return fail("permission")
        if (!bt.isEnabled) return fail("bluetooth_off")
        if (!bt.isLeExtendedAdvertisingSupported) return fail("extended_advertising_unsupported")
        val adv = bt.bluetoothLeAdvertiser ?: return fail("advertising_unsupported")
        advertiser = adv
        val parameters = AdvertisingSetParameters.Builder()
            .setLegacyMode(false)
            .setConnectable(false)
            .setScannable(false)
            .setInterval(AdvertisingSetParameters.INTERVAL_HIGH)
            .setTxPowerLevel(AdvertisingSetParameters.TX_POWER_MEDIUM)
            .setPrimaryPhy(BluetoothDevice.PHY_LE_1M)
            .setSecondaryPhy(BluetoothDevice.PHY_LE_1M)
            .build()
        return try {
            adv.startAdvertisingSet(parameters, advertiseData(token), null, null, null, advertisingCallback)
            true
        } catch (e: SecurityException) {
            fail("permission")
        } catch (e: IllegalArgumentException) {
            fail("advertise_rejected")
        } catch (e: IllegalStateException) {
            fail("bluetooth_off")
        }
    }

    private fun rotateAdvertising(token: ByteArray) {
        val set = advertisingSet
        if (set == null) {
            // The set is still coming up; start again with the new token instead.
            stopAdvertising()
            startAdvertising(token)
            return
        }
        try {
            set.setAdvertisingData(advertiseData(token))
        } catch (e: SecurityException) {
            stopWith("permission")
        } catch (e: IllegalStateException) {
            stopWith("bluetooth_off")
        }
    }

    private fun stopAdvertising() {
        try {
            advertiser?.stopAdvertisingSet(advertisingCallback)
        } catch (e: SecurityException) {
            // Already without permission: nothing more to stop.
        } catch (e: IllegalStateException) {
            // Bluetooth is off; the set is gone with it.
        }
        advertisingSet = null
        advertiser = null
    }

    private fun fail(reason: String): Boolean {
        stopWith(reason)
        return false
    }

    // --- Scanning ------------------------------------------------------------------------------

    private fun startScanning() {
        val bt = adapter ?: return
        val needed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Manifest.permission.BLUETOOTH_SCAN else Manifest.permission.ACCESS_FINE_LOCATION
        if (!granted(needed)) return
        val sc = bt.bluetoothLeScanner ?: return
        scanner = sc
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_BALANCED)
            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            .setLegacy(false)
            .setPhy(ScanSettings.PHY_LE_ALL_SUPPORTED)
            .apply { if (bt.isOffloadedScanBatchingSupported) setReportDelay(BleConstants.BATCH_MS) }
            .build()
        val filters = listOf(ScanFilter.Builder().setServiceUuid(serviceUuid).build())
        try {
            sc.startScan(filters, settings, scanCallback)
            scanning = true
        } catch (e: SecurityException) {
            scanning = false
        } catch (e: IllegalStateException) {
            scanning = false
        }
    }

    private fun stopScanning() {
        if (!scanning) return
        try {
            scanner?.stopScan(scanCallback)
        } catch (e: SecurityException) {
            // Nothing to do.
        } catch (e: IllegalStateException) {
            // Bluetooth is off.
        }
        scanning = false
        scanner = null
    }

    private fun record(result: ScanResult) {
        val data = result.scanRecord?.getServiceData(serviceUuid) ?: return
        if (data.size != BleConstants.TOKEN_BYTES) return
        val rssi = result.rssi
        if (rssi < BleConstants.MIN_REPORT_RSSI) return
        val token = encodeToken(data)
        val known = window[token]
        if (known == null || rssi > known) window[token] = rssi
    }
}
