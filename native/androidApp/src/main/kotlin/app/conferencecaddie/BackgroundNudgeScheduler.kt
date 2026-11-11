package app.conferencecaddie

import android.app.NotificationManager
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import app.conferencecaddie.shared.people.BackgroundNudges
import app.conferencecaddie.shared.people.PeopleAvailability
import app.conferencecaddie.shared.people.PeopleUiState
import kotlin.time.Clock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Keeps one periodic [BackgroundNudgeJobService] job scheduled exactly while
 * [BackgroundNudges.wanted] holds for the people state: a visible profile at a live conference with
 * presence on, and nudges allowed. The job is not persisted across a reboot (that would need
 * RECEIVE_BOOT_COMPLETED); the next time the app starts and creates its controller, this evaluates
 * again and schedules it if it is wanted.
 *
 * The job has no network constraint: a connectivity constraint needs the ACCESS_NETWORK_STATE
 * permission, which the manifest removes on purpose (ONNX Runtime's telemetry, see the manifest and
 * DECISIONS.md, phase 2b). Offline, the check's one request fails at once and the job ends.
 *
 * The job is changed only when the decision changes, and an already pending job is left alone, so
 * an app start does not restart the period.
 */
class BackgroundNudgeScheduler(
    context: Context,
    private val state: StateFlow<PeopleUiState>,
    private val scope: CoroutineScope,
    private val now: () -> Long = { Clock.System.now().toEpochMilliseconds() },
    private val notificationsAllowed: () -> Boolean = { notificationsAllowed(context) },
) {
    private val app = context.applicationContext
    private val jobs = app.getSystemService(JobScheduler::class.java)
    private var job: Job? = null

    /** Starts following the state. */
    fun start() {
        job?.cancel()
        job = scope.launch {
            // Only a ready state decides. A cold process starts as Loading and passes through states with
            // no conference while the core restores its selection; cancelling then would drop a job
            // that is still wanted. A job that is no longer wanted for those reasons cancels itself
            // the next time it runs.
            state.filter { it.availability == PeopleAvailability.Ready }
                .map { BackgroundNudges.wanted(it, now(), notificationsAllowed()) }
                .distinctUntilChanged()
                .collect { apply(it) }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    private fun apply(wanted: Boolean) {
        if (!wanted) {
            jobs.cancel(JOB_ID)
            return
        }
        if (jobs.getPendingJob(JOB_ID) != null) return
        val info = JobInfo.Builder(JOB_ID, ComponentName(app, BackgroundNudgeJobService::class.java))
            .setPeriodic(PERIOD_MS)
            .setPersisted(false)
            .build()
        jobs.schedule(info)
    }

    companion object {
        /** The fixed id of the one job. */
        const val JOB_ID = 4401

        /** JobScheduler's minimum period; a shorter one is raised to it. */
        const val PERIOD_MS = 15 * 60 * 1000L

        /** True when the system lets the app show notifications (Android 13 and newer: POST_NOTIFICATIONS, and the app's switch). */
        fun notificationsAllowed(context: Context): Boolean =
            context.applicationContext.getSystemService(NotificationManager::class.java).areNotificationsEnabled()
    }
}
