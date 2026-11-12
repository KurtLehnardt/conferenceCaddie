package app.conferencecaddie.shared.ble

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.PowerManager

/**
 * How [BleRadioService] wakes a sleeping phone and keeps it awake, behind one interface so the
 * instrumented tests can see what it asks for and fire it themselves: the alarms for the next window
 * change, the session's end and the runtime's next report, and the short wake lock that lets a report
 * go out once the phone is awake. [AndroidBleWakeups] is the real one.
 */
interface BleWakeups {
    /**
     * Wakes the phone at [atElapsedMillis] (on SystemClock.elapsedRealtime, which keeps counting while
     * the phone sleeps) and sends [action] to the running service. Inexact and allowed while idle, so
     * it needs no exact-alarm permission and may come some minutes late in Doze. One alarm per action:
     * setting it again moves it.
     */
    fun setAlarm(action: String, atElapsedMillis: Long)

    /** Cancels the alarm of [action], if one is set. */
    fun cancelAlarm(action: String)

    /** Keeps the processor running (a partial wake lock) for [timeoutMillis] from now; a new hold replaces the time left. */
    fun holdAwake(timeoutMillis: Long)

    /** Lets the processor sleep again before the hold's time is up; nothing when nothing is held. */
    fun releaseAwake()
}

/**
 * [BleWakeups] with the alarm manager and the power manager. An alarm is a broadcast to the service's
 * own receiver, which is registered only while the service runs, so once the process is gone it
 * reaches nothing; the alarm manager holds a wake lock until the receiver returns. The wake lock is
 * not reference counted and always has a timeout, so it can never be left held.
 */
class AndroidBleWakeups(context: Context) : BleWakeups {
    private val app = context.applicationContext
    private val alarms: AlarmManager? = app.getSystemService(AlarmManager::class.java)
    private val wakeLock: PowerManager.WakeLock? by lazy {
        app.getSystemService(PowerManager::class.java)
            ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG)
            ?.apply { setReferenceCounted(false) }
    }

    override fun setAlarm(action: String, atElapsedMillis: Long) {
        alarms?.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, atElapsedMillis, operation(action))
    }

    override fun cancelAlarm(action: String) {
        alarms?.cancel(operation(action))
    }

    override fun holdAwake(timeoutMillis: Long) {
        wakeLock?.acquire(timeoutMillis)
    }

    override fun releaseAwake() {
        val lock = wakeLock ?: return
        if (lock.isHeld) lock.release()
    }

    /** The broadcast of [action] within the app; PendingIntents of different actions are different alarms. */
    private fun operation(action: String): PendingIntent = PendingIntent.getBroadcast(
        app,
        REQUEST_CODE,
        Intent(action).setPackage(app.packageName),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private companion object {
        const val REQUEST_CODE = 3

        /** The wake lock's name in battery statistics; it names no person and no token. */
        const val WAKE_LOCK_TAG = "caddie:bluetooth-report"
    }
}
