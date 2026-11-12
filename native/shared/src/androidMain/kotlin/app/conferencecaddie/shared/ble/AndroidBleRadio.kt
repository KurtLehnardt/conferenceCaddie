package app.conferencecaddie.shared.ble

import android.Manifest
import android.app.ForegroundServiceStartNotAllowedException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import app.conferencecaddie.shared.AndroidPermissions

/**
 * [BleRadio] on Android: one per process ([get]), driving [BleRadioService], the foreground service
 * of type `connectedDevice` that advertises, serves the token characteristic and scans while the app
 * is in the background, with the screen off or swiped from Recents.
 *
 * The radio keeps the session the common runtime started (its configuration, payload source and
 * events) for the process, and the service reads it from here: when the service is already running a
 * new [start] switches it in place, and a system restart of the service ([onSystemRestart]) waits for
 * the runtime to call [start] again. Everything the service does happens on the main thread; the
 * methods here may be called from any thread and hand their work to it.
 *
 * **Starting from the background.** Android 12 and newer refuse to start a foreground service while
 * the app is in the background, which is where a cold start by the background nudge job restores the
 * session. Such a start is not a stop: the session is kept, the runtime is not told, and the start is
 * tried again when an activity of the app starts ([resumeDeferred]) or a service the system restarted
 * attaches.
 *
 * **Stop with nothing running.** The notification's Stop can arrive while no session is running in
 * the service: during the grace after a system restart, or from a notification left over in a new
 * process. The radio then remembers the Stop for [restartGraceMillis] and stops the next session the
 * runtime starts with [BleStopReason.User], so the runtime turns Bluetooth proximity off as the
 * person asked. A [stop] from the runtime forgets it: the runtime stops the radio when its restore
 * resumes nothing, so the Stop is never applied to a session the person starts later by hand.
 *
 * Permissions: on Android 12 and newer "Nearby devices" (BLUETOOTH_SCAN, BLUETOOTH_ADVERTISE and
 * BLUETOOTH_CONNECT, the scan declared as never used for location); on Android 8 to 11 the location
 * permission, which a scan needs there although no position is read (BLUETOOTH and BLUETOOTH_ADMIN
 * are granted at install). Android cannot tell "never asked" from "refused for good" without an
 * activity, so, like AndroidLocationProvider, the radio remembers that it has asked and asks the
 * attached activity ([AndroidPermissions]) whether the prompt would still show.
 */
class AndroidBleRadio private constructor(context: Context, notificationIcon: Int) : BleRadio {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val prefs by lazy { app.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    /** The small icon of the ongoing notification: the application's monochrome icon. */
    internal val notificationIcon: Int = notificationIcon

    /**
     * The Bluetooth stack the service uses. The instrumented tests replace it with a fake while the
     * radio is stopped; nothing else sets it.
     */
    @Volatile var hardware: BleHardware = AndroidBleHardware(app)

    /**
     * How long a service the system restarted waits for the runtime to [start] it again before it
     * stops: 30 seconds, enough to open the database and restore the session. The instrumented tests
     * shorten it; nothing else sets it.
     */
    @Volatile var restartGraceMillis: Long = 30_000L

    /** The clock of token windows and the deadline, in epoch milliseconds. The instrumented tests move it; nothing else sets it. */
    @Volatile var clock: () -> Long = System::currentTimeMillis

    /**
     * Starts [BleRadioService] for the foreground. The instrumented tests replace it to play
     * Android's refusal of a start from the background; nothing else sets it.
     */
    @Volatile var startService: (Intent) -> Unit = { app.startForegroundService(it) }

    /**
     * Whether a permission is granted. The instrumented tests replace it, because revoking a
     * permission ends the app's process; nothing else sets it.
     */
    @Volatile var permissionGranted: (String) -> Boolean = { app.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    /** What the runtime started: kept for the process, so the service can read it whenever it starts. */
    internal class Session(val config: BleRadioConfig, val source: BlePayloadSource, val events: BleRadioEvents)

    private val lock = Any()

    // Written under [lock] from any thread; the service reads them on the main thread.
    @Volatile internal var session: Session? = null
        private set

    @Volatile private var started = false

    /** The running service, attached by itself on the main thread. */
    internal var service: BleRadioService? = null

    /** A start intent was sent and the service has not attached yet. */
    private var serviceStarting = false

    /** A session whose service Android refused to start from the background; main thread. */
    private var deferred: Session? = null

    /** A Stop that found no session: honoured by the next [deliver] until this SystemClock.elapsedRealtime(); main thread. */
    private var userStopUntil = Long.MIN_VALUE

    override val supported: Boolean
        get() {
            val hw = hardware
            // Extended advertising can only be read while the adapter is on; when it is off, start
            // checks again.
            return hw.present() && (!hw.enabled() || hw.extendedAdvertisingSupported())
        }

    override val permissionKind: BlePermissionKind =
        if (Build.VERSION.SDK_INT >= 31) BlePermissionKind.NearbyDevices else BlePermissionKind.Location

    override val running: Boolean get() = started

    override fun access(): BleAccess {
        val missing = PERMISSIONS.filterNot { permissionGranted(it) }
        if (missing.isEmpty()) return BleAccess.Granted
        if (!asked()) return BleAccess.NotAsked
        // Asked before: the prompt still shows when Android wants a rationale (refused once). With no
        // activity attached there is no telling, and Denied lets the screens offer to ask again.
        return when (missing.firstNotNullOfOrNull { AndroidPermissions.shouldShowRationale(it) }) {
            false -> BleAccess.Blocked
            else -> BleAccess.Denied
        }
    }

    override suspend fun requestAccess(): BleAccess {
        if (access() == BleAccess.Granted) return BleAccess.Granted
        val answer = AndroidPermissions.request(*PERMISSIONS.toTypedArray())
        // Only an answer from the system counts as having asked, as in AndroidLocationProvider. With
        // no activity attached, or a prompt dismissed without a choice, the answer is empty; taking
        // that as asked would read as refused for good once an activity says no rationale is due.
        if (answer.isNotEmpty()) prefs.edit().putBoolean(KEY_ASKED, true).apply()
        return access()
    }

    /** Whether the radio (or, before Android 12, the location provider, which asks for the same permission) has asked. */
    private fun asked(): Boolean =
        prefs.getBoolean(KEY_ASKED, false) || (Build.VERSION.SDK_INT < 31 && prefs.getBoolean(KEY_LOCATION_ASKED, false))

    override fun state(): BleRadioState {
        val hw = hardware
        return when {
            !hw.present() -> BleRadioState.Unsupported
            access() != BleAccess.Granted -> BleRadioState.Unauthorized
            !hw.enabled() -> BleRadioState.PoweredOff
            !hw.extendedAdvertisingSupported() -> BleRadioState.Unsupported
            else -> BleRadioState.Ready
        }
    }

    override fun start(config: BleRadioConfig, source: BlePayloadSource, events: BleRadioEvents) {
        val s = Session(config, source, events)
        synchronized(lock) {
            session = s
            started = true
        }
        main.post { deliver(s) }
    }

    override fun refresh() {
        main.post { service?.refresh() }
    }

    override fun stop() {
        synchronized(lock) {
            session = null
            started = false
        }
        // A service still starting stops itself when it finds no session (after startForeground,
        // which a service started for the foreground must call whatever happens).
        main.post {
            deferred = null
            // A Stop remembered from the notification is spent: the runtime has stopped the radio
            // itself, which it also does when a restart restores nothing, so a session the person
            // starts by hand later is not taken for the one that Stop was meant for.
            userStopUntil = Long.MIN_VALUE
            service?.stopQuietly()
        }
    }

    /**
     * Tries again to start the service for a session Android refused to start from the background,
     * if there is one. The application calls it whenever one of its activities starts, which puts
     * the app in the foreground. Any thread.
     */
    fun resumeDeferred() {
        main.post {
            val d = deferred ?: return@post
            deferred = null
            deliver(d)
        }
    }

    /** Hands [s] to the running service, or starts the service for it. Main thread. */
    private fun deliver(s: Session) {
        if (session !== s) return
        if (userStopUntil != Long.MIN_VALUE) {
            val stop = SystemClock.elapsedRealtime() < userStopUntil
            userStopUntil = Long.MIN_VALUE
            if (stop) {
                // The person tapped Stop while nothing ran; this is the session the runtime restored.
                stopped(s, BleStopReason.User)
                service?.stopQuietly()
                return
            }
        }
        val running = service
        when {
            running != null -> running.apply(s)
            serviceStarting -> Unit // The service reads the session when it starts.
            else -> try {
                startService(Intent(app, BleRadioService::class.java).setAction(BleRadioService.ACTION_START))
                serviceStarting = true
                deferred = null
            } catch (e: IllegalStateException) {
                if (refusedInBackground(e)) {
                    // Android 12 and newer refuse a start from the background. The session stays
                    // (the runtime would otherwise drop its key and record), and the start is tried
                    // again once the app is in the foreground or the system restarts the service.
                    deferred = s
                } else {
                    stopped(s, BleStopReason.System)
                }
            } catch (e: SecurityException) {
                stopped(s, BleStopReason.PermissionLost)
            }
        }
    }

    /** Android 12 and newer's refusal to start a foreground service from the background. */
    private fun refusedInBackground(e: IllegalStateException): Boolean =
        Build.VERSION.SDK_INT >= 31 && e is ForegroundServiceStartNotAllowedException

    // --- Called by the service, on the main thread ------------------------------------------------

    internal fun attach(service: BleRadioService) {
        this.service = service
        serviceStarting = false
        // The service reads the session itself, a deferred one included.
        deferred = null
    }

    /**
     * The notification's Stop arrived at a service running no session. A session the service has not
     * taken up yet stops with [BleStopReason.User] now; otherwise the next session the runtime starts
     * within [restartGraceMillis] does.
     */
    internal fun userStopWithoutSession() {
        val s = session
        if (s != null) {
            deferred = null
            stopped(s, BleStopReason.User)
            return
        }
        userStopUntil = SystemClock.elapsedRealtime() + restartGraceMillis
    }

    internal fun detach(service: BleRadioService) {
        if (this.service === service) this.service = null
        serviceStarting = false
    }

    /** [s] stopped by itself for [reason]: the runtime hears of it unless it has stopped or replaced the session. */
    internal fun stopped(s: Session, reason: BleStopReason) {
        val current = synchronized(lock) {
            if (session !== s) return
            session = null
            started = false
            s
        }
        current.events.onStopped(reason)
    }

    companion object {
        private const val PREFS = "caddie_permissions"
        private const val KEY_ASKED = "ble_asked"

        /** AndroidLocationProvider's flag; before Android 12 the radio needs the same permission. */
        private const val KEY_LOCATION_ASKED = "location_asked"

        private val PERMISSIONS: List<String> =
            if (Build.VERSION.SDK_INT >= 31) {
                listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT)
            } else {
                listOf(Manifest.permission.ACCESS_FINE_LOCATION)
            }

        @Volatile private var instance: AndroidBleRadio? = null

        /**
         * The process's radio, created on first use with [notificationIcon] (the application's
         * monochrome status bar icon) for the ongoing notification; later calls return it as it is.
         */
        fun get(context: Context, notificationIcon: Int): AndroidBleRadio = instance ?: synchronized(this) {
            instance ?: AndroidBleRadio(context, notificationIcon).also { instance = it }
        }

        /** The process's radio if something has created it. */
        fun existing(): AndroidBleRadio? = instance

        /** True when the device has Bluetooth LE and an adapter, so the radio is worth creating at all. */
        fun isSupported(context: Context): Boolean = AndroidBleHardware(context).present()

        /**
         * Set by the application in `onCreate`: creates the process's people features (and with them
         * this radio) when the system restarts [BleRadioService] in a new process, so the common
         * runtime can restore its session and call [start] again. Called on the main thread with the
         * application context. Without it, a restarted service stops after [restartGraceMillis].
         */
        @Volatile var onSystemRestart: ((Context) -> Unit)? = null
    }
}
