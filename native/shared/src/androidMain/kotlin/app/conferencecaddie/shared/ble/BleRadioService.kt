package app.conferencecaddie.shared.ble

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
 * **One token per connection.** A phone that stayed connected to the GATT server across a window
 * change could read two tokens over one link and tie them together, which rotation is there to
 * prevent. Each connection is served only the payload it read first ([BleTokenReaders]); a read of
 * another is refused, and whenever the payload changes the connections that read an earlier one are
 * ended. Devices that never read the token (a watch bonded to this phone) are left alone.
 *
 * **Clocks.** The window boundary and the session's end ([BleRadioConfig.untilEpochMillis]) are
 * kept on the elapsed-realtime clock, which keeps counting while the phone sleeps; a Handler alone
 * counts uptime and would let a sleeping phone advertise past its presence. A Handler acts on time
 * while the phone is awake, every scan callback checks both whenever it runs, and an inexact
 * allow-while-idle alarm ([BleWakeups]) wakes the phone for the next one. The alarm needs no
 * exact-alarm permission and may come some minutes late in Doze; the payload of a late window is
 * still accepted by the server, which resolves the windows before and after the current one. The
 * runtime's next report ([AndroidBleRadio.keepAwakeUntil]) gets an alarm of its own, which calls
 * [BleRadioEvents.onReportDue] and holds a partial wake lock for [REPORT_AWAKE_MS], so the report can
 * go out before the phone sleeps again.
 *
 * **Scanning.** The scan starts again at a refresh when it failed, and at every new window anyway,
 * because Android turns a scan that has run for 30 minutes into an opportunistic one that only hears
 * what other apps' scans hear. On Android 10 and 11 a scan gets results only while the app is in
 * front (the location permission there is "while in use", and a `connectedDevice` service has no
 * location access of its own), so there it is never started again from the background, and after a
 * sticky restart in the background the notification says "Open Caddie to keep listening" until an
 * activity starts ([appCameToFront]), which starts the scan again.
 *
 * **Stopping.** The service stops for good at the session's end ([BleStopReason.System]), when
 * Bluetooth is switched off, when the Stop action is tapped, when advertising fails or a permission
 * is missing, and when the runtime calls [AndroidBleRadio.stop]; every stop but the last is reported
 * through [BleRadioEvents.onStopped]. Swiping the app from Recents does not stop it. A failure to
 * restart the advertising sets at a window change is tried once more a second later
 * ([ADVERTISE_RETRY_MS]) before it ends the session, because the stack refuses a set now and then
 * while it is still taking the previous one down.
 *
 * **Starting.** A service started for the foreground calls startForeground before it attaches to the
 * radio, so nothing the radio posts in between (a stop, a finished session) can stop it before
 * Android has seen it in the foreground, which Android punishes by ending the app.
 *
 * **Restarts.** The service is sticky: tokens are derived, so a service the system restarted after
 * ending the process advertises current tokens, and the session's end still applies (the 11-minute
 * "stale token" stop of the Capacitor app, which made discovery stop silently on 2026-11-09, is
 * gone). A restart arrives with no intent and an empty process; the service then calls
 * [AndroidBleRadio.onSystemRestart], which creates the people features, whose runtime restores its
 * session and calls [AndroidBleRadio.start] again. If nothing has started it after
 * [AndroidBleRadio.restartGraceMillis], it stops.
 *
 * **The notification.** Android 14 and newer let the person swipe the ongoing notification away,
 * which would hide the Stop action; while the service runs it is posted again.
 *
 * Declared in the application's manifest with `foregroundServiceType="connectedDevice"`, not
 * exported. Nothing here logs an address, a payload or a token.
 */
class BleRadioService : Service() {
    private val main = Handler(Looper.getMainLooper())

    private var radio: AndroidBleRadio? = null
    private var hardware: BleHardware? = null
    private var wakeups: BleWakeups? = null

    /** The session being run, or null before the first and after a stop. Read from a GATT binder thread too. */
    @Volatile private var active: AndroidBleRadio.Session? = null
    private var interrogation: BleInterrogation? = null
    private var advertisedWindow = Long.MIN_VALUE

    /** The payload the advertising sets carry now, or null while nothing is advertised. */
    private var advertisedPayload: ByteArray? = null

    /** The session's end on SystemClock.elapsedRealtime(). */
    private var deadlineElapsed = Long.MAX_VALUE
    private var leaving = false

    /** The scan runs: it started and has not failed since. */
    private var scanning = false

    /**
     * Android 10 and 11: the system restarted the service while the app was not in front, so the scan
     * may hear nothing until the app is opened, and the notification says so.
     */
    private var needsAppToListen = false

    /** The connections that read the token, and which payload each was served; read from a GATT binder thread too. */
    private val readers = BleTokenReaders()

    private val tick = Runnable { onTick() }
    private val pump = Runnable { interrogateNext() }
    private val graceStop = Runnable { if (active == null) stopQuietly() }
    private val advertiseRetry = Runnable { retryAdvertising() }

    /** The app's own broadcasts to the running service: its alarms and the notification's dismissal. */
    private val receiver = object : BroadcastReceiver() {
        // The alarm manager holds a wake lock until this returns, so the steps it takes complete.
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_TICK -> onTick()
                ACTION_REPORT_DUE -> onReportDue()
                ACTION_NOTIFICATION_DELETED -> onNotificationDeleted()
            }
        }
    }

    /**
     * Answers reads of the token characteristic, from a binder thread, with the payload of the window
     * now, once per connection ([BleTokenReaders]).
     */
    private val reader = object : BleCharacteristicReader {
        override fun read(device: String, offset: Int): BleGattAnswer = readers.answer(device, offset, payloadNow(active))

        override fun disconnected(device: String) = readers.disconnected(device)
    }

    private val scanListener = object : BleScanListener {
        override fun onAdvertisements(advertisements: List<BleAdvertisement>) = heard(advertisements)

        override fun onScanFailed() {
            // Advertising and the GATT server keep going without the scan: other phones can still
            // find this one, as in the Capacitor app. The next refresh starts it again.
            scanning = false
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        BleRadioNotification.ensureChannel(this)
        val filter = IntentFilter().apply {
            addAction(ACTION_TICK)
            addAction(ACTION_REPORT_DUE)
            addAction(ACTION_NOTIFICATION_DELETED)
        }
        registerNotExported(receiver, filter)
        // Not attached to the radio yet: onStartCommand attaches once the service is in the
        // foreground, so nothing the radio posts in between can stop it before startForeground.
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
                // The notification's Stop action.
                val s = active
                if (s != null) {
                    finish(s, BleStopReason.User)
                } else {
                    // No session here: the grace after a system restart, or a notification left
                    // over in a new process. The Stop still counts: the radio stops the session the
                    // runtime restores. When nothing has created the people features yet, the hook
                    // creates them, so the runtime restores the session and hears of the Stop.
                    if (AndroidBleRadio.existing() == null) AndroidBleRadio.onSystemRestart?.invoke(applicationContext)
                    AndroidBleRadio.existing()?.userStopWithoutSession()
                    teardown()
                    // Only when nothing started the service after this Stop: a start for the
                    // foreground already on its way must reach startForeground before the service
                    // stops, or Android ends the app. That start then finds no session and stops.
                    if (stopSelfResult(startId)) {
                        leaving = true
                        radio?.detach(this)
                        stopForeground(STOP_FOREGROUND_REMOVE)
                    }
                }
                return START_NOT_STICKY
            }
            ACTION_START -> {
                // A start for the foreground must call startForeground whatever happens next, and
                // before the service attaches to the radio (see onCreate).
                val refused = enterForeground()
                val r = AndroidBleRadio.existing()?.also { attachTo(it) }
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
                // In the foreground first: the hook can take a while, and a service restarted for the
                // foreground must call startForeground in time.
                val icon = AndroidBleRadio.existing()?.notificationIcon
                if (enterForeground() != null) {
                    // Android 12 and newer may refuse a foreground service to an app in the
                    // background. The session's record stays, and the app restores it when it opens.
                    stopQuietly()
                    return START_NOT_STICKY
                }
                // The hook creates the process's people features, or finds them when they exist.
                AndroidBleRadio.onSystemRestart?.invoke(applicationContext)
                val r = AndroidBleRadio.existing()?.also { attachTo(it) }
                // Android 10 and 11: restarted with the app in the background, the scan may hear
                // nothing until the app is opened, and the notification asks for that.
                needsAppToListen = r != null && r.scanNeedsAppInFront && !r.appInFront()
                // The notification went up before the radio existed, with the application's icon:
                // shown again with the radio's monochrome one (and the words of the moment).
                if (r != null && (r.notificationIcon != icon || needsAppToListen)) enterForeground()
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
        try {
            unregisterReceiver(receiver)
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

    /** Starts the foreground state (or shows its notification again); returns why it was refused, or null. */
    private fun enterForeground(): BleStopReason? {
        val icon = (radio ?: AndroidBleRadio.existing())?.notificationIcon ?: applicationInfo.icon
        val notification = BleRadioNotification.build(this, icon, openToListen = needsAppToListen)
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
        if (wakeups == null) wakeups = r.wakeups
        val now = r.clock()
        deadlineElapsed = SystemClock.elapsedRealtime() + (s.config.untilEpochMillis - now)
        active = s
        val reason = when {
            s.config.untilEpochMillis <= now -> BleStopReason.System
            !hw.enabled() -> BleStopReason.BluetoothOff
            !hw.extendedAdvertisingSupported() -> BleStopReason.Unsupported
            hw.locationOff() -> BleStopReason.LocationOff
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
            // Android 8 to 11: with the Location switch off a scan hears nothing.
            hw.watchLocation { if (hardware?.locationOff() == true) active?.let { finish(it, BleStopReason.LocationOff) } }
        }
        // Only where the legacy connectable set is offered: before Android 14 nothing could reach the
        // server but this phone's own connections, through which the peer can read the phone's name.
        if ((previous == null || !sameUuids) && hw.connectableAdvertising()) {
            // A new server has no connections yet.
            readers.clear()
            // Without the GATT server only phones that receive extended advertisements find this one;
            // that is still worth running, so only a missing permission or Bluetooth off end it.
            when (hw.openGattServer(serviceUuid, characteristicUuid, reader)) {
                BleHardwareStatus.NoPermission -> return finish(s, BleStopReason.PermissionLost)
                BleHardwareStatus.Off -> return finish(s, BleStopReason.BluetoothOff)
                else -> Unit
            }
        }
        if (!advertise(s)) return
        if ((previous == null || !sameUuids) && !scan(s)) return
        if (previous == null || previous.config.nearRssi != s.config.nearRssi || !sameUuids) {
            hw.cancelInterrogation()
            interrogation = BleInterrogation(s.config.nearRssi)
        }
        arm()
    }

    /** The window changed, or the key did: advertise the payload of now. */
    internal fun refresh() {
        val s = active ?: return
        val r = radio ?: return
        if (leaving || pastDeadline(s)) return
        // The runtime and this service's own timer both refresh at a window start. When the sets
        // already carry the payload of now, restarting them again a moment later gains nothing and
        // races the stack's pending starts, so only a new payload (a new window or a new key)
        // restarts them.
        val window = BleProtocol.windowAtMillis(r.clock())
        val payload = payloadNow(s)
        if (payload != null && payload.contentEquals(advertisedPayload) && advertisedWindow == window) {
            arm()
            return
        }
        val newWindow = window != advertisedWindow
        if (advertise(s, mayRetry = true) && rescan(s, newWindow)) arm()
    }

    /**
     * The runtime's next report is due at [epochMillis]: an alarm wakes the phone then, so a report
     * whose own timer cannot run while the phone sleeps still goes out ([onReportDue]).
     */
    internal fun reportDueAt(epochMillis: Long) {
        val r = radio ?: return
        if (leaving || active == null) return
        val at = SystemClock.elapsedRealtime() + (epochMillis - r.clock()).coerceAtLeast(0L)
        wakeups?.setAlarm(ACTION_REPORT_DUE, at)
    }

    /**
     * An activity of the app started. On Android 10 and 11 a scan started from the background may
     * hear nothing, so one started after a sticky restart, or one that failed meanwhile, starts again
     * now, and the notification stops asking to open the app.
     */
    internal fun appCameToFront() {
        val r = radio ?: return
        if (leaving) return
        val waited = needsAppToListen
        if (waited) {
            needsAppToListen = false
            enterForeground()
        }
        val s = active ?: return
        if (r.scanNeedsAppInFront && (waited || !scanning)) scan(s)
    }

    /** [AndroidBleRadio.stop]: ends everything without telling the runtime, which asked for it. */
    internal fun stopQuietly() {
        teardown()
        leave()
    }

    // --- Running -----------------------------------------------------------------------------------

    /**
     * (Re)starts both advertising sets with the payload of now, which also gives them a new address.
     * Returns false when the session has stopped because of it. With [mayRetry] (a refresh, not the
     * session's first start), a refusal by the stack is tried once more after [ADVERTISE_RETRY_MS]
     * before it ends the session.
     */
    private fun advertise(s: AndroidBleRadio.Session, mayRetry: Boolean = false): Boolean {
        val hw = hardware ?: return false
        val r = radio ?: return false
        // This attempt replaces any retry still waiting.
        main.removeCallbacks(advertiseRetry)
        advertisedWindow = BleProtocol.windowAtMillis(r.clock())
        val payload = payloadNow(s)
        // A connection that read another payload (an earlier window, or the key before) must not stay
        // connected into this one: its reads are refused already, and it is ended here.
        val stale = readers.servedOtherThan(payload)
        if (stale.isNotEmpty()) hw.disconnectGattClients(stale)
        if (payload == null) {
            // No key (it is being replaced, or it is gone): advertise nothing rather than a stale
            // payload, and keep listening. The runtime refreshes or stops the radio.
            hw.stopAdvertising()
            advertisedPayload = null
            return true
        }
        advertisedPayload = payload
        val status = hw.startAdvertising(UUID.fromString(s.config.serviceUuid), payload) {
            if (active !== s || leaving) return@startAdvertising
            if (mayRetry) advertiseAgainLater() else finish(s, BleStopReason.AdvertiseFailed)
        }
        val reason = when (status) {
            BleHardwareStatus.Ok -> null
            BleHardwareStatus.NoPermission -> BleStopReason.PermissionLost
            BleHardwareStatus.Off -> BleStopReason.BluetoothOff
            BleHardwareStatus.Failed -> if (mayRetry) {
                advertiseAgainLater()
                return true
            } else {
                BleStopReason.AdvertiseFailed
            }
        }
        if (reason != null) {
            finish(s, reason)
            return false
        }
        return true
    }

    /**
     * The stack refused to restart the sets at a refresh: nothing is advertised for a moment (the
     * scan and the GATT server go on), and the sets are tried once more after [ADVERTISE_RETRY_MS].
     */
    private fun advertiseAgainLater() {
        hardware?.stopAdvertising()
        advertisedPayload = null
        main.removeCallbacks(advertiseRetry)
        main.postDelayed(advertiseRetry, ADVERTISE_RETRY_MS)
    }

    /** The one retry after a refused refresh: a second refusal ends the session, as at the start. */
    private fun retryAdvertising() {
        val s = active ?: return
        if (leaving || pastDeadline(s)) return
        if (advertise(s, mayRetry = false)) arm()
    }

    /** Starts (or restarts) the scan for [s]; returns false when the session has stopped because of it. */
    private fun scan(s: AndroidBleRadio.Session): Boolean {
        val hw = hardware ?: return false
        return when (hw.startScan(UUID.fromString(s.config.serviceUuid), scanListener)) {
            BleHardwareStatus.Ok -> {
                scanning = true
                true
            }
            BleHardwareStatus.NoPermission -> {
                finish(s, BleStopReason.PermissionLost)
                false
            }
            BleHardwareStatus.Off -> {
                finish(s, BleStopReason.BluetoothOff)
                false
            }
            // Advertising and the GATT server go on without it; the next refresh tries again.
            BleHardwareStatus.Failed -> {
                scanning = false
                true
            }
        }
    }

    /**
     * At a refresh: starts the scan again when it is not running, and at every [newWindow] anyway,
     * because Android turns a scan that has run for 30 minutes into an opportunistic one. Never from
     * the background where the scan needs the app in front (Android 10 and 11): a scan started there
     * hears nothing, while one started with the app in front keeps hearing. Returns false when the
     * session has stopped because of it.
     */
    private fun rescan(s: AndroidBleRadio.Session, newWindow: Boolean): Boolean {
        val r = radio ?: return false
        if (scanning && !newWindow) return true
        if (r.scanNeedsAppInFront && !r.appInFront()) return true
        return scan(s)
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
            // Other Apple advertisements come far more often from AirPods, watches and Macs than from
            // a Caddie phone, and every connection this phone makes lets the peer read its name (the
            // GAP Device Name is readable by the central's peer on every Android version): only the
            // service UUID and the iOS overflow area are worth one. The scan filter already drops
            // most of them.
            if (kind == BleInterrogation.Kind.Apple) continue
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

    /** The report alarm ([reportDueAt]): the phone is awake for a moment, long enough for the runtime's report. */
    private fun onReportDue() {
        val s = active ?: return
        if (leaving || pastDeadline(s)) return
        // The alarm manager's wake lock ends when the receiver returns; the report goes out over the
        // network after that, so the phone is kept awake a little longer. The hold ends by itself.
        wakeups?.holdAwake(REPORT_AWAKE_MS)
        s.events.onReportDue()
    }

    /** The person swiped the ongoing notification away (Android 14 and newer allow it): posted again while the service runs. */
    private fun onNotificationDeleted() {
        if (leaving) return
        enterForeground()
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
        wakeups?.setAlarm(ACTION_TICK, next)
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
        main.removeCallbacks(advertiseRetry)
        wakeups?.let { w ->
            w.cancelAlarm(ACTION_TICK)
            w.cancelAlarm(ACTION_REPORT_DUE)
            w.releaseAwake()
        }
        wakeups = null
        hardware?.let { hw ->
            hw.cancelInterrogation()
            hw.stopScan()
            hw.stopAdvertising()
            hw.closeGattServer()
            hw.unwatchAdapter()
            hw.unwatchLocation()
        }
        hardware = null
        readers.clear()
        scanning = false
        advertisedWindow = Long.MIN_VALUE
        advertisedPayload = null
        deadlineElapsed = Long.MAX_VALUE
    }

    /**
     * Registers [receiver] for broadcasts from this app only, as ContextCompat.registerReceiver does
     * with RECEIVER_NOT_EXPORTED: with the flag from Android 13 on, and before that behind the
     * signature permission that AndroidX Core and the app's manifest declare for this purpose, which
     * only an app signed with the app's key can hold. The alarms and the notification's dismissal are
     * PendingIntents of the app, sent with its identity, so they get through; no other app can make
     * the service act.
     */
    private fun registerNotExported(receiver: BroadcastReceiver, filter: IntentFilter) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(receiver, filter, "$packageName$NOT_EXPORTED_PERMISSION", null)
        }
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
        internal const val ACTION_TICK = "app.conferencecaddie.ble.TICK"

        /** The report alarm's broadcast ([AndroidBleRadio.keepAwakeUntil]), received only by a running service. */
        internal const val ACTION_REPORT_DUE = "app.conferencecaddie.ble.REPORT_DUE"

        /** The ongoing notification was swiped away. */
        internal const val ACTION_NOTIFICATION_DELETED = "app.conferencecaddie.ble.NOTIFICATION_DELETED"

        /** The suffix (after the application id) of the signature permission behind the receiver before Android 13. */
        private const val NOT_EXPORTED_PERMISSION = ".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"

        /**
         * How long the phone stays awake after the report alarm: enough for the runtime to send one
         * report over a slow network, short enough that a phone in a pocket barely notices it.
         */
        internal const val REPORT_AWAKE_MS = 15_000L

        /** A connection that has not read the characteristic by then is given up. */
        private const val INTERROGATION_TIMEOUT_MS = 5_000L

        private const val DEFAULT_RESTART_GRACE_MS = 30_000L

        /** A refresh the stack refused is tried once more after this long. */
        private const val ADVERTISE_RETRY_MS = 1_000L
    }
}
