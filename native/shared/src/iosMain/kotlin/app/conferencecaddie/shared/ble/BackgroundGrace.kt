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
 * background task until [graceMillis] after the last one (or until iOS says the time is up). In the
 * foreground nothing is held.
 */
internal interface WakeHold {
    /** An event was delivered: hold the app (in the background) for the grace period from now. */
    fun hold()

    /** Lets go at once (the radio stopped). */
    fun release()
}

/**
 * [WakeHold] on `beginBackgroundTaskWithName`. Every UIApplication call runs on the main queue, as
 * UIKit requires; the task and its timer live there too. Nothing touches UIApplication before the
 * first [hold], so a radio in a test process (which has no UIApplication) can be stopped freely.
 */
internal class UiBackgroundGrace(private val graceMillis: Long = GRACE_MS) : WakeHold {
    // Main queue only.
    private var task = UIBackgroundTaskInvalid
    private var generation = 0

    @kotlin.concurrent.Volatile
    private var used = false

    override fun hold() {
        used = true
        dispatch_async(dispatch_get_main_queue()) {
            val app = UIApplication.sharedApplication
            if (app.applicationState != UIApplicationState.UIApplicationStateBackground) return@dispatch_async
            if (task == UIBackgroundTaskInvalid) {
                // The expiration handler runs on the main thread when iOS is about to suspend the app.
                task = app.beginBackgroundTaskWithName(TASK_NAME) { end() }
            }
            val mine = ++generation
            @OptIn(ExperimentalForeignApi::class)
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, graceMillis * 1_000_000L), dispatch_get_main_queue()) {
                if (mine == generation) end()
            }
        }
    }

    override fun release() {
        if (!used) return
        dispatch_async(dispatch_get_main_queue()) { end() }
    }

    /** Main queue only. */
    private fun end() {
        generation++
        if (task == UIBackgroundTaskInvalid) return
        UIApplication.sharedApplication.endBackgroundTask(task)
        task = UIBackgroundTaskInvalid
    }

    companion object {
        /** How long after the last event the app is held, at most (iOS may end it sooner). */
        const val GRACE_MS = 20_000L

        private const val TASK_NAME = "Caddie Bluetooth sightings"
    }
}
