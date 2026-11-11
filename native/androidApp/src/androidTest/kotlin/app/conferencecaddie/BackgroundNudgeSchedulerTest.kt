package app.conferencecaddie

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.conferencecaddie.shared.people.ConferenceInfo
import app.conferencecaddie.shared.people.PeopleAvailability
import app.conferencecaddie.shared.people.PeopleFeatures
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.shared.people.Presence
import app.conferencecaddie.shared.people.Visibility
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** The scheduler keeps the periodic nudge job scheduled exactly while a background check is wanted. */
@RunWith(AndroidJUnit4::class)
class BackgroundNudgeSchedulerTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val jobs = context.getSystemService(JobScheduler::class.java)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val state = MutableStateFlow(wanted())
    private var notifications = true
    private val now = 1_800_000_000_000L // 2027-01-15, inside the conference below

    private fun wanted() = PeopleUiState(
        availability = PeopleAvailability.Ready,
        conference = ConferenceInfo("c", "C", timeZone = "UTC", startDate = "2027-01-14", endDate = "2027-01-16"),
        features = PeopleFeatures(enabled = true, presence = true),
        visibility = Visibility(openToMeet = true),
        presence = Presence(on = true, zone = "Hall"),
        nudgesOn = true,
    )

    @Before
    fun clean() {
        jobs.cancel(BackgroundNudgeScheduler.JOB_ID)
    }

    @After
    fun tearDown() {
        scope.cancel()
        jobs.cancel(BackgroundNudgeScheduler.JOB_ID)
    }

    private fun scheduler() = BackgroundNudgeScheduler(context, state, scope, now = { now }, notificationsAllowed = { notifications })

    private fun awaitPending(expected: Boolean): JobInfo? = runBlocking {
        withTimeout(10_000) {
            while ((jobs.getPendingJob(BackgroundNudgeScheduler.JOB_ID) != null) != expected) delay(50)
            jobs.getPendingJob(BackgroundNudgeScheduler.JOB_ID)
        }
    }

    @Test
    fun schedulesAPeriodicNetworkJobWhenWantedAndCancelsItWhenNot() {
        scheduler().start()
        val info = awaitPending(true)
        assertNotNull(info)
        assertTrue(info!!.isPeriodic)
        assertEquals(15 * 60 * 1000L, info.intervalMillis)
        assertEquals(JobInfo.NETWORK_TYPE_NONE, info.networkType)
        assertTrue(!info.isPersisted)
        assertEquals(BackgroundNudgeJobService::class.java.name, info.service.className)

        // Going invisible cancels it, and a new presence schedules it again.
        state.value = wanted().copy(visibility = Visibility(openToMeet = false))
        assertNull(awaitPending(false))
        state.value = wanted()
        assertNotNull(awaitPending(true))

        // Presence ending, and the conference ending, cancel it too.
        state.value = wanted().copy(presence = Presence())
        assertNull(awaitPending(false))
        state.value = wanted()
        awaitPending(true)
        state.value = wanted().copy(conference = ConferenceInfo("c", "C", timeZone = "UTC", endDate = "2027-01-14"))
        assertNull(awaitPending(false))
    }

    @Test
    fun doesNotScheduleWhileNotificationsAreOffAndIgnoresStatesThatAreNotReady() {
        notifications = false
        scheduler().start()
        runBlocking { delay(500) }
        assertNull(jobs.getPendingJob(BackgroundNudgeScheduler.JOB_ID))

        // A Loading state (a cold start) does not cancel a pending job.
        notifications = true
        state.value = wanted().copy(saveCount = 2)
        awaitPending(true)
        state.value = PeopleUiState(availability = PeopleAvailability.Loading)
        runBlocking { delay(500) }
        assertNotNull(jobs.getPendingJob(BackgroundNudgeScheduler.JOB_ID))
    }

    @Test
    fun leavesAPendingJobAloneWhenItIsStillWanted() {
        scheduler().start()
        awaitPending(true)
        // Another scheduler (the next process) must not replace the job that is already pending.
        val first = jobs.getPendingJob(BackgroundNudgeScheduler.JOB_ID)
        state.value = wanted().copy(saveCount = 1)
        runBlocking { delay(300) }
        assertEquals(first, jobs.getPendingJob(BackgroundNudgeScheduler.JOB_ID))
    }
}
