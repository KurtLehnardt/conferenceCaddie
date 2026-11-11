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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

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
 * An already pending job is left alone, so an app start does not restart the period.
 *
 * [jobId] is [JOB_ID] in the app. The instrumented tests give their scheduler another id, because
 * they run in the app's process, where the process's own scheduler ([CaddiePeople]) and a run of
 * the job itself cancel [JOB_ID] whenever the real people state does not want it.
 */
class BackgroundNudgeScheduler(
    context: Context,
    private val state: StateFlow<PeopleUiState>,
    private val scope: CoroutineScope,
    private val now: () -> Long = { Clock.System.now().toEpochMilliseconds() },
    private val notificationsAllowed: () -> Boolean = { notificationsAllowed(context) },
    private val jobId: Int = JOB_ID,
) {
    private val app = context.applicationContext
    private val jobs = app.getSystemService(JobScheduler::class.java)
    private var job: Job? = null
    private val applyLock = Mutex()

    /** Starts following the state. */
    fun start() {
        job?.cancel()
        job = scope.launch {
            // Only a ready state decides. A cold process starts as Loading and passes through states with
            // no conference while the core restores its selection; cancelling then would drop a job
            // that is still wanted. A job that is no longer wanted for those reasons cancels itself
            // the next time it runs.
            //
            // Every ready state applies the decision again, rather than only a changed one: the job
            // cancels itself when it finds it is not wanted (notifications switched off in the
            // system, a backend without people features), which this flow cannot see, so a later
            // state that wants it again must schedule it again. apply() leaves a pending job alone,
            // so its period is not restarted.
            state.filter { it.availability == PeopleAvailability.Ready }
                .map { BackgroundNudges.wanted(it, now(), notificationsAllowed()) }
                .collect { apply(it) }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    /**
     * Applies the decision to the current state again, for a change no state shows: the person
     * may have switched the app's notifications on in the system settings, after the job had
     * cancelled itself for that. The app calls it when it comes back to the foreground.
     */
    fun recheck() {
        val s = state.value
        if (s.availability != PeopleAvailability.Ready) return
        scope.launch { apply(BackgroundNudges.wanted(s, now(), notificationsAllowed())) }
    }

    /**
     * Serialised, because the [start] collector and a [recheck] can run at the same time. A
     * JobScheduler call that throws (the system's job limit, a state it refuses) must not end the
     * collector: the next ready state applies the decision again.
     */
    private suspend fun apply(wanted: Boolean) = applyLock.withLock {
        runCatching {
            if (!wanted) {
                if (jobs.getPendingJob(jobId) != null) jobs.cancel(jobId)
            } else if (jobs.getPendingJob(jobId) == null) {
                val info = JobInfo.Builder(jobId, ComponentName(app, BackgroundNudgeJobService::class.java))
                    .setPeriodic(PERIOD_MS)
                    .setPersisted(false)
                    .build()
                jobs.schedule(info)
            }
        }.onFailure { if (it is CancellationException) throw it }
        Unit
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
