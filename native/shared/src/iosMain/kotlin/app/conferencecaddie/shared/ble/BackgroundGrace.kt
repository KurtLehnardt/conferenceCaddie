package app.conferencecaddie.shared.ble

import kotlinx.cinterop.ExperimentalForeignApi
import platform.UIKit.UIApplication
import platform.UIKit.UIApplicationState
import platform.UIKit.UIBackgroundTaskInvalid
import platform.darwin.DISPATCH_TIME_NOW
import platform.darwin.dispatch_after
import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_main_queue
import platform.darwin.dispatch_time

/**
 * Keeps the app running for a while after the radio delivered an event in the background.
 *
 * iOS wakes a backgrounded app for a Bluetooth event and suspends it again after "around 10
 * seconds" (docs/NATIVE_PLAN.md 5.1). The common runtime reports what it heard to the server inside
 * that wake, which can take longer on a crowded network, so each delivered event holds a UIKit
 * background task until [graceMillis] after the last one (or until iOS says the time is up). When the
 * runtime says when it reports next ([BleRadio.keepAwakeUntil]), the hold lasts until a little after
 * then. In the foreground nothing is held.
 */
internal interface WakeHold {
    /** An event was delivered: hold the app (in the background) for the grace period from now. */
    fun hold()

    /**
     * Holds the app (in the background) until [epochMillis] plus a margin for the work due then, and
     * for the grace period from now at least. Never shortens a hold.
     */
    fun holdUntil(epochMillis: Long)

    /** Lets go at once (the radio stopped). */
    fun release()
}

/**
 * When a hold that ends at [currentEnd] (epoch milliseconds; 0 when nothing is held) ends after a
 * [WakeHold.hold] at [now], or a [WakeHold.holdUntil] of [requested]: the latest of the current end,
 * the grace from now, and [requested] plus [margin]. A hold is only ever extended.
 */
internal fun wakeHoldEnd(now: Long, currentEnd: Long, graceMillis: Long, requested: Long? = null, margin: Long = HOLD_UNTIL_MARGIN_MS): Long {
    var end = maxOf(currentEnd, now + graceMillis)
    if (requested != null) end = maxOf(end, requested + margin)
    return end
}

/** How long a [WakeHold.holdUntil] holds past the time asked for, for the work due then (an upload). */
internal const val HOLD_UNTIL_MARGIN_MS = 5_000L

/**
 * What [UiBackgroundGrace] needs from UIKit and the main queue, so its pairing of begun and ended
 * background tasks can be checked without a UIApplication ([UiKitBackgroundTasks] in the app).
 */
internal interface BackgroundTasks {
    /** Runs [block] on the main queue, later. */
    fun onMain(block: () -> Unit)

    /** Runs [block] on the main queue after [millis]. */
    fun onMainAfter(millis: Long, block: () -> Unit)

    /** True while the app is in the background. Main queue only. */
    fun inBackground(): Boolean

    /** Begins a background task, whose [onExpired] runs on the main queue when iOS is about to suspend the app; null when iOS gives none. Main queue only. */
    fun begin(onExpired: () -> Unit): ULong?

    /** Ends the background task [task]. Main queue only. */
    fun end(task: ULong)
}

/** [BackgroundTasks] on UIApplication and the main dispatch queue. */
internal object UiKitBackgroundTasks : BackgroundTasks {
    override fun onMain(block: () -> Unit) = dispatch_async(dispatch_get_main_queue(), block)

    @OptIn(ExperimentalForeignApi::class)
    override fun onMainAfter(millis: Long, block: () -> Unit) =
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, millis * 1_000_000L), dispatch_get_main_queue(), block)

    override fun inBackground(): Boolean = UIApplication.sharedApplication.applicationState == UIApplicationState.UIApplicationStateBackground

    override fun begin(onExpired: () -> Unit): ULong? =
        UIApplication.sharedApplication.beginBackgroundTaskWithName(TASK_NAME, onExpired).takeIf { it != UIBackgroundTaskInvalid }

    override fun end(task: ULong) = UIApplication.sharedApplication.endBackgroundTask(task)

    private const val TASK_NAME = "Caddie Bluetooth sightings"
}

/**
 * [WakeHold] on `beginBackgroundTaskWithName`. Every UIApplication call runs on the main queue, as
 * UIKit requires; the task, its end and its timer live there too. One task at a time: begun by the
 * first hold in the background and ended once, by the timer at the hold's end, by [release], or by
 * iOS's expiration handler. Nothing touches UIApplication before the first hold, so a radio in a
 * test process (which has no UIApplication) can be stopped freely.
 */
internal class UiBackgroundGrace(
    private val graceMillis: Long = GRACE_MS,
    private val clock: () -> Long = ::epochMillis,
    private val tasks: BackgroundTasks = UiKitBackgroundTasks,
) : WakeHold {
    // Main queue only.
    private var task: ULong? = null
    private var generation = 0

    /** When the hold ends, in epoch milliseconds; 0 while nothing is held. Main queue only. */
    private var endsAt = 0L

    @kotlin.concurrent.Volatile
    private var used = false

    override fun hold() = extend(null)

    override fun holdUntil(epochMillis: Long) = extend(epochMillis)

    private fun extend(requested: Long?) {
        used = true
        tasks.onMain {
            if (!tasks.inBackground()) return@onMain
            if (task == null) {
                // The expiration handler runs on the main thread when iOS is about to suspend the app.
                task = tasks.begin { end() }
            }
            val now = clock()
            val next = wakeHoldEnd(now, endsAt, graceMillis, requested)
            if (next == endsAt) return@onMain
            endsAt = next
            val mine = ++generation
            tasks.onMainAfter(next - now) {
                if (mine == generation) end()
            }
        }
    }

    override fun release() {
        if (!used) return
        tasks.onMain { end() }
    }

    /** Main queue only. */
    private fun end() {
        generation++
        endsAt = 0L
        val t = task ?: return
        task = null
        tasks.end(t)
    }

    companion object {
        /** How long after the last event the app is held, at most (iOS may end it sooner). */
        const val GRACE_MS = 20_000L
    }
}
