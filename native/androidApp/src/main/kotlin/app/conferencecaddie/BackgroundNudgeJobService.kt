package app.conferencecaddie

import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import app.conferencecaddie.shared.people.BackgroundNudges
import app.conferencecaddie.shared.people.PeopleAvailability
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The periodic background nudge check ([BackgroundNudgeScheduler]). It may start a cold process
 * with no activity. It takes the process's controller ([CaddiePeople]), waits a little while for the
 * state to be ready, checks again that a nudge check is wanted (cancelling its own job when it is not:
 * the conference ended, notifications were switched off in the system, presence ran out), and then
 * runs [app.conferencecaddie.shared.people.PeopleController.backgroundCheck], which shows at most one
 * local notification whose text names nobody. Nothing runs on the main thread.
 */
class BackgroundNudgeJobService : JobService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var run: Job? = null

    override fun onStartJob(params: JobParameters): Boolean {
        run = scope.launch {
            runCheck()
            // A stopped job is already finished as far as the system is concerned.
            if (isActive) jobFinished(params, false)
        }
        return true
    }

    // The system stops the job (its conditions no longer hold, or time ran out): ask to be run again.
    override fun onStopJob(params: JobParameters): Boolean {
        run?.cancel()
        return true
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun runCheck() {
        val app = applicationContext
        // A process with no activity is in the background, whatever the controller starts out
        // believing: without this its poll would keep running in the cached process. The activity
        // reports foreground itself when it starts.
        val controller = CaddiePeople.controller(app)
        if (!CaddieApplication.hasStartedActivity) controller.setForeground(false)
        val ready = withTimeoutOrNull(READY_WAIT_MS) { controller.state.first { it.availability == PeopleAvailability.Ready } } ?: return
        val now = controller.clock.now().toEpochMilliseconds()
        if (!BackgroundNudges.wanted(ready, now, BackgroundNudgeScheduler.notificationsAllowed(app))) {
            getSystemService(JobScheduler::class.java).cancel(BackgroundNudgeScheduler.JOB_ID)
            return
        }
        controller.backgroundCheck()
    }

    private companion object {
        const val READY_WAIT_MS = 30_000L
    }
}
