package app.conferencecaddie.shared.ble

import android.app.AlarmManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import java.util.UUID

/**
 * The foreground service behind Bluetooth proximity on Android ([AndroidBleRadio]): while the common
 * runtime has a session running, it advertises this phone's payload, serves it from the token
 * characteristic, scans for other phones and reads the ones that need a connection
 * ([BleInterrogation]), with an ongoing notification ([BleRadioNotification]) carrying a Stop action.
 * All Bluetooth calls go through [BleHardware].
 *
 * **Tokens and windows.** The payload is never stored here: every advertisement and every read asks
 * the session's [BlePayloadSource] for the payload of the window now, which the runtime derives from
 * the key with no network call. At every window start the two advertising sets are stopped and
 * started again with the new payload, so the stack draws a new address for them and the address
 * changes together with the token (docs/contracts/ble-tokens.md, mitigation 4). The runtime also
 * calls [AndroidBleRadio.refresh] then; the service does it by itself as well, because the runtime's
 * timers may not run while the phone sleeps.
 *
 * **Clocks.** The window boundary and the session's end ([BleRadioConfig.untilEpochMillis]) are
 * kept on the elapsed-realtime clock, which keeps counting while the phone sleeps; a Handler alone
 * counts uptime and would let a sleeping phone advertise past its presence. A Handler acts on time
 * while the phone is awake, every scan callback checks both whenever it runs, and an inexact
 * allow-while-idle alarm wakes the phone for the next one. The alarm needs no exact-alarm permission
 * and may come some minutes late in Doze; the payload of a late window is still accepted by the
 * server, which resolves the windows before and after the current one.
 *
 * **Stopping.** The service stops for good at the session's end ([BleStopReason.System]), when
 * Bluetooth is switched off, when the Stop action is tapped, when advertising fails or a permission
 * is missing, and when the runtime calls [AndroidBleRadio.stop]; every stop but the last is reported
 * through [BleRadioEvents.onStopped]. Swiping the app from Recents does not stop it.
 *
 * **Restarts.** The service is sticky: tokens are derived, so a service the system restarted after
 * ending the process advertises current tokens, and the session's end still applies (the 11-minute
 * "stale token" stop of the Capacitor app, which made discovery stop silently on 2026-11-09, is
 * gone). A restart arrives with no intent and an empty process; the service then calls
 * [AndroidBleRadio.onSystemRestart], which creates the people features, whose runtime restores its
 * session and calls [AndroidBleRadio.start] again. If nothing has started it after
 * [AndroidBleRadio.restartGraceMillis], it stops.
 *
 * Declared in the application's manifest with `foregroundServiceType="connectedDevice"`, not
 * exported. Nothing here logs an address, a payload or a token.
 */
class BleRadioService : Service() {
    private val main = Handler(Looper.getMainLooper())

    private var radio: AndroidBleRadio? = null
    private var hardware: BleHardware? = null

    /** The session being run, or null before the first and after a stop. Read from a GATT binder thread too. */
    @Volatile private var active: AndroidBleRadio.Session? = null
    private var interrogation: BleInterrogation? = null
    private var advertisedWindow = Long.MIN_VALUE

    /** The session's end on SystemClock.elapsedRealtime(). */
    private var deadlineElapsed = Long.MAX_VALUE
    private var leaving = false

    private val tick = Runnable { onTick() }
    private val pump = Runnable { interrogateNext() }
    private val graceStop = Runnable { if (active == null) stopQuietly() }

    private val tickReceiver = object : BroadcastReceiver() {
        // The alarm manager holds a wake lock until this returns, so the steps it takes complete.
        override fun onReceive(context: Context, intent: Intent) = onTick()
    }

    private val alarms by lazy { getSystemService(AlarmManager::class.java) }

    /** A broadcast to [tickReceiver]; once the process is gone it reaches nothing. */
    private val tickAlarm: PendingIntent by lazy {
        PendingIntent.getBroadcast(
            this,
            3,
            Intent(ACTION_TICK).setPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    /** Answers reads of the token characteristic, from a binder thread, with the payload of the window now. */
    private val reader = BleCharacteristicReader { offset -> BleGattAnswer.of(payloadNow(active), offset) }

    private val scanListener = object : BleScanListener {
        override fun onAdvertisements(advertisements: List<BleAdvertisement>) = heard(advertisements)

        override fun onScanFailed() {
            // Advertising and the GATT server keep going without the scan: other phones can still
            // find this one, as in the Capacitor app.
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        BleRadioNotification.ensureChannel(this)
        val filter = IntentFilter(ACTION_TICK)
        // Not exported from Android 13 on, where the flag exists. Before, another app could send the
        // broadcast too, but it only makes the service look at its clocks.
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(tickReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(tickReceiver, filter)
        }
        AndroidBleRadio.existing()?.let { attachTo(it) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (leaving) {
            // Already on its way out. A start for the foreground still owes Android its
            // startForeground; anything started after the stop goes to the next instance.
            if (intent?.action == ACTION_START && enterForeground() == null) stopForeground(STOP_FOREGROUND_REMOVE)
            return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_STOP -> {
                // The notification's Stop action: only a running service shows it.
                val s = active
                if (s != null) finish(s, BleStopReason.User) else stopQuietly()
                return START_NOT_STICKY
            }
            ACTION_START -> {
                val r = AndroidBleRadio.existing()?.also { attachTo(it) }
                // A start for the foreground must call startForeground whatever happens next.
                val refused = enterForeground()
                val s = r?.session
                when {
                    refused != null -> {
                        if (s != null) r.stopped(s, refused)
                        stopQuietly()
                    }
                    s == null -> stopQuietly() // Stopped before the service came up.
                    else -> apply(s)
                }
            }
            else -> {
                // No intent: the system restarted the service after ending the process. (An intent
                // without an action, which nothing in the app sends, is taken the same way.)
                if (active != null) return START_STICKY
                // The hook creates the process's people features, or finds them when they exist.
                AndroidBleRadio.onSystemRestart?.invoke(applicationContext)
                val r = AndroidBleRadio.existing()?.also { attachTo(it) }
                if (enterForeground() != null) {
                    // Android 12 and newer may refuse a foreground service to an app in the
                    // background; the runtime's start then fails the same way and hears of it.
                    stopQuietly()
                    return START_NOT_STICKY
                }
                val s = r?.session
                if (s != null) {
                    apply(s)
                } else {
                    main.removeCallbacks(graceStop)
                    main.postDelayed(graceStop, r?.restartGraceMillis ?: DEFAULT_RESTART_GRACE_MS)
                }
            }
        }
        return if (leaving) START_NOT_STICKY else START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiping the app from Recents leaves the service running: finding people with the phone in
        // a pocket is what it is for. Only Stop, the session's end or the runtime stop it.
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        alarms.cancel(tickAlarm)
        try {
            unregisterReceiver(tickReceiver)
        } catch (e: IllegalArgumentException) {
            // Not registered.
        }
        // Destroyed without having stopped itself (the system ended it): the runtime hears of it.
        val s = active
        teardown()
        if (s != null) radio?.stopped(s, BleStopReason.System)
        radio?.detach(this)
        super.onDestroy()
    }

    private fun attachTo(r: AndroidBleRadio) {
        radio = r
        r.attach(this)
    }

    /** Starts the foreground state; returns why it was refused, or null. */
    private fun enterForeground(): BleStopReason? {
        val icon = radio?.notificationIcon ?: applicationInfo.icon
        val notification = BleRadioNotification.build(this, icon)
        return try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(BleRadioNotification.NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
            } else {
                startForeground(BleRadioNotification.NOTIFICATION_ID, notification)
            }
            null
        } catch (e: SecurityException) {
            // Android 14 and newer require a Bluetooth permission for a connectedDevice service.
            BleStopReason.PermissionLost
        } catch (e: IllegalStateException) {
            // ForegroundServiceStartNotAllowedException and the service type exceptions.
            BleStopReason.System
        }
    }

    // --- Called by AndroidBleRadio, on the main thread ---------------------------------------------

    /** Runs [s]: starts everything for the first session, or switches the running radio to it. */
    internal fun apply(s: AndroidBleRadio.Session) {
        val r = radio ?: return
        // A session is applied once: the restart path and the radio's own delivery may both bring it.
        if (leaving || active === s) return
        main.removeCallbacks(graceStop)
        val previous = active
        val hw = hardware ?: r.hardware
        val now = r.clock()
        deadlineElapsed = SystemClock.elapsedRealtime() + (s.config.untilEpochMillis - now)
        active = s
        val reason = when {
            s.config.untilEpochMillis <= now -> BleStopReason.System
            !hw.enabled() -> BleStopReason.BluetoothOff
            !hw.extendedAdvertisingSupported() -> BleStopReason.Unsupported
            else -> null
        }
        if (reason != null) {
            finish(s, reason)
            return
        }
        val serviceUuid = UUID.fromString(s.config.serviceUuid)
        val characteristicUuid = UUID.fromString(s.config.characteristicUuid)
        val sameUuids = previous != null && previous.config.serviceUuid == s.config.serviceUuid &&
            previous.config.characteristicUuid == s.config.characteristicUuid
        if (previous == null || hardware == null) {
            hardware = hw
            hw.watchAdapter { active?.let { finish(it, BleStopReason.BluetoothOff) } }
        }
        if (previous == null || !sameUuids) {
            // Without the GATT server only phones that receive extended advertisements find this one;
            // that is still worth running, so only a missing permission or Bluetooth off end it.
            when (hw.openGattServer(serviceUuid, characteristicUuid, reader)) {
                BleHardwareStatus.NoPermission -> return finish(s, BleStopReason.PermissionLost)
                BleHardwareStatus.Off -> return finish(s, BleStopReason.BluetoothOff)
                else -> Unit
            }
        }
        if (!advertise(s)) return
        if (previous == null || !sameUuids) {
            when (hw.startScan(serviceUuid, scanListener)) {
                BleHardwareStatus.NoPermission -> return finish(s, BleStopReason.PermissionLost)
                BleHardwareStatus.Off -> return finish(s, BleStopReason.BluetoothOff)
                else -> Unit
            }
        }
        if (previous == null || previous.config.nearRssi != s.config.nearRssi || !sameUuids) {
            hw.cancelInterrogation()
            interrogation = BleInterrogation(s.config.nearRssi)
        }
        arm()
    }

    /** The window changed, or the key did: advertise the payload of now. */
    internal fun refresh() {
        val s = active ?: return
        if (leaving || pastDeadline(s)) return
        if (advertise(s)) arm()
    }

    /** [AndroidBleRadio.stop]: ends everything without telling the runtime, which asked for it. */
    internal fun stopQuietly() {
        teardown()
        leave()
    }

    // --- Running -----------------------------------------------------------------------------------

    /**
     * (Re)starts both advertising sets with the payload of now, which also gives them a new address.
     * Returns false when the session has stopped because of it.
     */
    private fun advertise(s: AndroidBleRadio.Session): Boolean {
        val hw = hardware ?: return false
        val r = radio ?: return false
        advertisedWindow = BleProtocol.windowAtMillis(r.clock())
        val payload = payloadNow(s)
        if (payload == null) {
            // No key (it is being replaced, or it is gone): advertise nothing rather than a stale
            // payload, and keep listening. The runtime refreshes or stops the radio.
            hw.stopAdvertising()
            return true
        }
        val status = hw.startAdvertising(UUID.fromString(s.config.serviceUuid), payload) {
            active?.takeIf { it === s }?.let { finish(it, BleStopReason.AdvertiseFailed) }
        }
        val reason = when (status) {
            BleHardwareStatus.Ok -> null
            BleHardwareStatus.NoPermission -> BleStopReason.PermissionLost
            BleHardwareStatus.Off -> BleStopReason.BluetoothOff
            BleHardwareStatus.Failed -> BleStopReason.AdvertiseFailed
        }
        if (reason != null) {
            finish(s, reason)
            return false
        }
        return true
    }

    /** The session's payload now, or null; a failing key store must not take the service down. */
    private fun payloadNow(s: AndroidBleRadio.Session?): ByteArray? {
        if (s == null) return null
        return try {
            s.source.payloadNow()
        } catch (e: RuntimeException) {
            null
        }
    }

    /** Advertisements from the scan: payloads go to the runtime, devices without one may be read. */
    private fun heard(advertisements: List<BleAdvertisement>) {
        val s = active ?: return
        val r = radio ?: return
        if (leaving || pastDeadline(s)) return
        val now = r.clock()
        if (BleProtocol.windowAtMillis(now) != advertisedWindow) {
            refresh()
            if (active !== s) return
        }
        val policy = interrogation
        for (ad in advertisements) {
            if (ad.rssi < s.config.nearRssi) continue
            val data = ad.serviceData
            if (data != null) {
                if (BleProtocol.decodePayload(data) != null) s.events.onHeard(data.copyOf(), ad.rssi, now)
                continue
            }
            val kind = BleInterrogation.kindOf(ad.advertisesService, null, ad.appleData, ad.connectable) ?: continue
            policy?.offer(ad.address, ad.rssi, kind, now)
        }
        interrogateNext()
    }

    /** Connects to the next device worth reading, if the policy allows one now. */
    private fun interrogateNext() {
        main.removeCallbacks(pump)
        val s = active ?: return
        val r = radio ?: return
        val hw = hardware ?: return
        val policy = interrogation ?: return
        if (leaving || policy.busy) return
        val now = r.clock()
        val candidate = policy.next(now)
        if (candidate == null) {
            policy.nextAttemptAt(now)?.let { main.postDelayed(pump, (it - now).coerceAtLeast(0L)) }
            return
        }
        val serviceUuid = UUID.fromString(s.config.serviceUuid)
        val characteristicUuid = UUID.fromString(s.config.characteristicUuid)
        hw.interrogate(candidate.address, serviceUuid, characteristicUuid, INTERROGATION_TIMEOUT_MS) { result ->
            // A result for a session or policy that has since been replaced is dropped.
            if (active !== s || interrogation !== policy) return@interrogate
            val at = r.clock()
            val outcome = when (result) {
                is BleReadResult.Value -> if (BleProtocol.decodePayload(result.bytes) != null) {
                    s.events.onHeard(result.bytes.copyOf(), candidate.rssi, at)
                    BleInterrogation.Outcome.Read
                } else {
                    BleInterrogation.Outcome.NotCaddie
                }
                BleReadResult.NotFound -> BleInterrogation.Outcome.NotCaddie
                BleReadResult.Failed -> BleInterrogation.Outcome.Failed
                BleReadResult.NoPermission -> {
                    finish(s, BleStopReason.PermissionLost)
                    return@interrogate
                }
            }
            policy.finished(candidate.address, outcome, at)
            interrogateNext()
        }
    }

    /** The Handler or the alarm: the session's end, or a new window. */
    private fun onTick() {
        val s = active ?: return
        val r = radio ?: return
        if (leaving || pastDeadline(s)) return
        if (BleProtocol.windowAtMillis(r.clock()) != advertisedWindow) refresh() else arm()
    }

    /** Stops the session with [BleStopReason.System] and returns true when its end has passed. */
    private fun pastDeadline(s: AndroidBleRadio.Session): Boolean {
        if (SystemClock.elapsedRealtime() < deadlineElapsed) return false
        finish(s, BleStopReason.System)
        return true
    }

    /**
     * Sets the Handler (on time while the phone is awake) and the alarm (wakes a sleeping phone) for
     * the next window start or the session's end, whichever comes first. One alarm replaces the last.
     */
    private fun arm() {
        val r = radio ?: return
        main.removeCallbacks(tick)
        val now = r.clock()
        val elapsed = SystemClock.elapsedRealtime()
        val nextWindow = elapsed + (BleProtocol.windowStartMillis(BleProtocol.windowAtMillis(now) + 1) - now)
        val next = minOf(nextWindow, deadlineElapsed)
        main.postDelayed(tick, (next - elapsed).coerceAtLeast(0L))
        alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, next, tickAlarm)
    }

    /** Stops for [reason] and tells the runtime, if [s] is still its session. */
    private fun finish(s: AndroidBleRadio.Session, reason: BleStopReason) {
        teardown()
        radio?.stopped(s, reason)
        leave()
    }

    /** Stops every Bluetooth activity and timer; safe to call more than once. */
    private fun teardown() {
        active = null
        interrogation = null
        main.removeCallbacks(tick)
        main.removeCallbacks(pump)
        main.removeCallbacks(graceStop)
        alarms.cancel(tickAlarm)
        hardware?.let { hw ->
            hw.cancelInterrogation()
            hw.stopScan()
            hw.stopAdvertising()
            hw.closeGattServer()
            hw.unwatchAdapter()
        }
        hardware = null
        advertisedWindow = Long.MIN_VALUE
        deadlineElapsed = Long.MAX_VALUE
    }

    private fun leave() {
        leaving = true
        radio?.detach(this)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    companion object {
        internal const val ACTION_START = "app.conferencecaddie.ble.START"
        internal const val ACTION_STOP = "app.conferencecaddie.ble.STOP"

        /** The wake-up alarm's broadcast, received only by a running service. */
        private const val ACTION_TICK = "app.conferencecaddie.ble.TICK"

        /** A connection that has not read the characteristic by then is given up. */
        private const val INTERROGATION_TIMEOUT_MS = 5_000L

        private const val DEFAULT_RESTART_GRACE_MS = 30_000L
    }
}
