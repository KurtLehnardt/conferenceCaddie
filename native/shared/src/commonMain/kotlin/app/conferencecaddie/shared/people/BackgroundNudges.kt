package app.conferencecaddie.shared.people

import kotlin.time.Instant

/**
 * When a platform's periodic background task has anything to do for nudges. Android schedules one
 * (JobScheduler) while [wanted] holds and cancels it when it stops holding; the task itself calls
 * [PeopleController.backgroundCheck], which needs presence on in a zone, nudges on for the
 * conference and the person open to meet (`ConnectRuntime.nudgeTick`), so a task scheduled without
 * those would wake the phone and do nothing.
 */
object BackgroundNudges {
    /**
     * True when a background nudge check can show a notification for the selected conference of
     * [state] at [nowMs]: the people features and presence are offered, the person is visible
     * (open to meet) at a conference that still takes people writes ([ConferenceWindow.isLive], in the
     * conference's own time zone), no delete covers it, presence is on in a zone and has not run out,
     * nudges are on for the conference, and the system lets the app show notifications
     * ([notificationsAllowed]).
     */
    fun wanted(state: PeopleUiState, nowMs: Long, notificationsAllowed: Boolean): Boolean {
        if (!notificationsAllowed) return false
        if (state.availability != PeopleAvailability.Ready) return false
        if (!state.features.enabled || !state.features.presence) return false
        val conference = state.conference ?: return false
        if (!ConferenceWindow.isLive(conference, nowMs)) return false
        if (state.deletes.deleteAll || state.deletes.coversConference) return false
        if (!state.visibility.openToMeet || !state.nudgesOn) return false
        val presence = state.presence
        if (!presence.on || presence.zone == null) return false
        val until = presence.until?.let { runCatching { Instant.parse(it).toEpochMilliseconds() }.getOrNull() }
        return until == null || nowMs < until
    }
}
