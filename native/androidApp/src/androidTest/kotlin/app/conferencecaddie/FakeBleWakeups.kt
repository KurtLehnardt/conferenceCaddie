package app.conferencecaddie

import app.conferencecaddie.shared.ble.BleWakeups
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * A [BleWakeups] that records the alarms the service sets and the wake lock it holds, so a test can
 * check when the phone would wake and fire an alarm itself (by sending its action, which the
 * service's real receiver gets) instead of waiting for it.
 */
class FakeBleWakeups : BleWakeups {
    /** The alarms set now, by action, at their SystemClock.elapsedRealtime() time. */
    val alarms = ConcurrentHashMap<String, Long>()

    /** Every wake lock hold's timeout, in order. */
    val holds = CopyOnWriteArrayList<Long>()
    @Volatile var releases = 0

    /** Held since the last hold, until a release (the fake's time never runs out). */
    @Volatile var held = false

    override fun setAlarm(action: String, atElapsedMillis: Long) {
        alarms[action] = atElapsedMillis
    }

    override fun cancelAlarm(action: String) {
        alarms.remove(action)
    }

    override fun holdAwake(timeoutMillis: Long) {
        holds += timeoutMillis
        held = true
    }

    override fun releaseAwake() {
        releases++
        held = false
    }
}
