package app.conferencecaddie.shared.people

import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/**
 * A People API request that did not succeed, mapped by the contract's client rule
 * (docs/contracts/people-api.md, "Client rule for errors"): the stable codes have a [Kind] of their
 * own, and any other `error` falls back to the kind of its status class. [message] is the line the
 * web app shows for it (`friendly()` and `explainBadRequest()` in web/src/people/api.ts), so a
 * screen can show it as it is.
 */
class PeopleError(
    /** The HTTP status; 0 when no answer arrived (offline, a timeout) or nothing was sent. */
    val status: Int,
    val kind: Kind,
    /** The answer's `error` field: a stable code, or a human-readable English message that must not be parsed. */
    val code: String?,
    /** The line to show the user. */
    val message: String,
    /** The answer's own `message` field, at most 200 characters (filtered, presence_required, not_around, paused). */
    val serverMessage: String? = null,
    /** share_required: how many people share for the talk. */
    val count: Int? = null,
    /** meet_open: the meet already open between the two. */
    val meetId: String? = null,
    /** state and over: the meet's state. */
    val state: MeetState? = null,
    /** paused: when asking works again (ISO time). */
    val retryAt: String? = null,
    /** Seconds the server asked the client to wait (Retry-After), or null. */
    val retryAfterSeconds: Long? = null,
) {
    enum class Kind {
        // Stable codes (400, 403, 404, 409, 410, 429).
        Filtered,

        /**
         * 400 `presence_not_active`: a presence write with `until: "keep"` while no presence is live
         * on the server (none stored, or it has run out). Nothing was written: presence is off there.
         */
        PresenceNotActive,
        Forbidden,
        CrossOrigin,
        ProfileRequired,
        VisibilityRequired,
        ShareRequired,
        PresenceRequired,
        BleRequired,
        BleRekey,
        Blocked,
        Hidden,
        NotFound,
        NotAround,
        MeetOpen,
        State,
        Over,
        Paused,

        /** 404 `push_unavailable`: this backend does not push to the platform of a native push registration. */
        PushUnavailable,

        /** 429 without a stable code: over a rate limit; wait for [retryAfterSeconds]. */
        RateLimited,

        /** 503 `daily_limit`: the API's daily request budget is spent. */
        DailyLimit,

        // Fallbacks by status class.
        /** Any other 4xx not listed below, mostly 400: the input was refused. */
        Refused,

        /** Any other 403 or 404: the action is not possible now. */
        NotPossible,

        /** Any other 409: a concurrent change; read again, retry at most once. */
        Conflict,

        /** Any other 410: the thing is over. */
        Gone,

        /** 5xx: try again later. */
        Unavailable,

        // Nothing usable came back.
        /** The request failed on the network. */
        Offline,

        /** The answer did not arrive within the request's time limit. */
        Timeout,

        /** A 2xx whose body is not the shape the contract promises. */
        BadResponse,

        // Refused on the device, nothing sent.
        /** This device has no credential for the backend yet, so there is nothing to ask about. */
        NoDevice,

        /** A delete of the profile covers this conference, so nothing that could make it visible again is sent. */
        DeleteUnfinished,

        /** The backend does not offer this (its capabilities say so), or no conference is selected. */
        NotOffered,
    }

    /** True when nothing was answered by the server. */
    val noAnswer: Boolean get() = status == 0

    override fun toString(): String = "PeopleError(status=$status, kind=$kind, code=$code)"

    companion object {
        /** The server's own wording for a text field that the filter held back. */
        const val FILTERED_MESSAGE = "That was held back by the filter. Edit it and try again."

        /** Shown when a request waited too long for the server's answer. */
        const val TIMEOUT_MESSAGE = "The server did not answer in time. Try again."

        const val OFFLINE_MESSAGE = "You appear to be offline. Check your connection and try again."
        const val TOO_MANY_MESSAGE = "Too many requests. Wait a minute and try again."
        const val NOT_ALLOWED_MESSAGE = "This device is not allowed to do that."
        const val UNAVAILABLE_MESSAGE = "This is unavailable right now. Please try again."
        const val NOT_SAVED_MESSAGE = "That could not be saved. Check your details and try again."
        const val NOT_AROUND_MESSAGE = "They're not around right now."
        const val PRESENCE_REQUIRED_MESSAGE = "Turn on 'Around and up for a conversation' first."

        /**
         * Shown when a write that could make the device visible again is asked for while a delete
         * covers its conference.
         */
        const val DELETE_UNFINISHED_MESSAGE =
            "Removing your profile has not finished. Finish it first with Try again at the top of your profile."

        private val FIELD_LABELS = mapOf(
            "display_name" to "Your name",
            "about" to "About me",
            "interests" to "\"What I'm trying to learn or figure out next\"",
            "expertise" to "\"Things I've built, run or broken\"",
            "contact_note" to "\"Another way to reach me\"",
        )

        /**
         * The server's English explanation of a refused write, in plain words without field names
         * (`explainBadRequest()` in the web app), or null when the app has no wording for it.
         */
        fun explainBadRequest(code: String?): String? {
            if (code == null) return null
            if (code.startsWith("display_name is required")) return "Add your name to your profile first."
            Regex("^(\\w+) must be at most (\\d+) characters$").find(code)?.let { m ->
                val label = FIELD_LABELS[m.groupValues[1]] ?: "One of your details"
                return "$label is too long: ${m.groupValues[2]} characters at most. Shorten it in your profile."
            }
            if (code.startsWith("linkedin_url must be")) {
                return "The LinkedIn link should look like https://www.linkedin.com/in/your-name. Fix it in your profile."
            }
            if (Regex("^(learn|speak)_topics contains an unknown topic").containsMatchIn(code)) {
                return "A topic you picked is no longer offered. Open your profile and remove it."
            }
            if (Regex("^(learn|speak)_topics must be an array").containsMatchIn(code)) {
                return "Your topics could not be saved. Open your profile and check the topics you picked."
            }
            if (Regex("^shared_talk_ids (contains an unknown talk|must be talks of this conference)").containsMatchIn(code)) {
                return "A talk you share for is no longer in the schedule. Tap \"Stop sharing for all\", then share again."
            }
            if (code.startsWith("shared_talk_ids must be an array")) return "You can share for up to 50 talks."
            if (code.startsWith("conference has ended")) return "This conference has ended, so sharing is closed."
            if (code.startsWith("conference is not available")) return "Sharing is not open for this conference."
            return null
        }

        /** The web's `friendly()`: the generic line for a status and code. */
        fun friendly(status: Int, code: String? = null, message: String? = null): String = when {
            code == "filtered" -> message ?: FILTERED_MESSAGE
            code == "not_around" -> message ?: NOT_AROUND_MESSAGE
            code == "presence_required" -> message ?: PRESENCE_REQUIRED_MESSAGE
            status == 0 -> OFFLINE_MESSAGE
            status == 429 -> message ?: TOO_MANY_MESSAGE
            status == 403 -> NOT_ALLOWED_MESSAGE
            status >= 500 -> UNAVAILABLE_MESSAGE
            else -> NOT_SAVED_MESSAGE
        }

        /**
         * "People features are paused until 3:00 PM. Saved schedules still work offline." for a 503
         * `daily_limit` (`pausedMessage()` in web/src/lib/pace.ts), in the device's time zone.
         */
        fun pausedMessage(retryAfter: String?, nowMs: Long, zone: TimeZone = TimeZone.currentSystemDefault(), what: String = "People features"): String {
            val at = resumeAt(retryAfter, nowMs)
            val local = Instant.fromEpochMilliseconds(at).toLocalDateTime(zone)
            val hour12 = if (local.hour % 12 == 0) 12 else local.hour % 12
            val time = "$hour12:${local.minute.toString().padStart(2, '0')} ${if (local.hour < 12) "AM" else "PM"}"
            return "$what are paused until $time. Saved schedules still work offline."
        }

        /** When a daily cap lifts: from Retry-After in seconds, else the next 00:00 UTC. */
        private fun resumeAt(retryAfter: String?, nowMs: Long): Long {
            val secs = retryAfter?.trim()?.toDoubleOrNull()
            if (secs != null && secs.isFinite() && secs > 0) return nowMs + (secs * 1000).toLong()
            val day = 86_400_000L
            return (nowMs / day + 1) * day
        }

        /** Builds the error for an answer with [status] and its parsed body fields. */
        internal fun fromAnswer(
            status: Int,
            code: String?,
            serverMessage: String?,
            count: Int?,
            meetId: String?,
            state: String?,
            retryAt: String?,
            retryAfter: String?,
            nowMs: Long,
        ): PeopleError {
            val retryAfterSeconds = retryAfter?.trim()?.takeIf { Regex("^\\d{1,6}$").matches(it) }?.toLong()
            val kind = kindOf(status, code)
            val message = when {
                status == 503 && code == "daily_limit" -> pausedMessage(retryAfter, nowMs)
                status == 400 -> explainBadRequest(code) ?: friendly(status, code, serverMessage)
                else -> friendly(status, code, serverMessage)
            }
            return PeopleError(
                status = status,
                kind = kind,
                code = code,
                message = message,
                serverMessage = serverMessage,
                count = count,
                meetId = meetId,
                state = MeetState.fromCode(state),
                retryAt = retryAt,
                retryAfterSeconds = retryAfterSeconds,
            )
        }

        /** The kind of an answer: its stable code when it has one for this status, else its status class. */
        fun kindOf(status: Int, code: String?): Kind {
            val stable = when (status) {
                400 -> when (code) {
                    "filtered" -> Kind.Filtered
                    "presence_not_active" -> Kind.PresenceNotActive
                    else -> null
                }
                403 -> when (code) {
                    "forbidden" -> Kind.Forbidden
                    "cross-origin request" -> Kind.CrossOrigin
                    "profile_required" -> Kind.ProfileRequired
                    "visibility_required" -> Kind.VisibilityRequired
                    "share_required" -> Kind.ShareRequired
                    "presence_required" -> Kind.PresenceRequired
                    "ble_required" -> Kind.BleRequired
                    "ble_rekey" -> Kind.BleRekey
                    "blocked" -> Kind.Blocked
                    "hidden" -> Kind.Hidden
                    else -> null
                }
                404 -> when (code) {
                    "not_found" -> Kind.NotFound
                    "push_unavailable" -> Kind.PushUnavailable
                    else -> null
                }
                409 -> when (code) {
                    "not_around" -> Kind.NotAround
                    "meet_open" -> Kind.MeetOpen
                    "state" -> Kind.State
                    else -> null
                }
                410 -> if (code == "over") Kind.Over else null
                429 -> if (code == "paused") Kind.Paused else null
                503 -> if (code == "daily_limit") Kind.DailyLimit else null
                else -> null
            }
            if (stable != null) return stable
            return when {
                status == 403 || status == 404 -> Kind.NotPossible
                status == 409 -> Kind.Conflict
                status == 410 -> Kind.Gone
                status == 429 -> Kind.RateLimited
                status >= 500 -> Kind.Unavailable
                else -> Kind.Refused
            }
        }

        internal fun offline() = PeopleError(0, Kind.Offline, null, OFFLINE_MESSAGE)

        internal fun timeout() = PeopleError(0, Kind.Timeout, "timeout", TIMEOUT_MESSAGE)

        internal fun badResponse(status: Int) = PeopleError(status, Kind.BadResponse, null, UNAVAILABLE_MESSAGE)

        /** No credential for this backend: the web's 403 `no_device`. */
        internal fun noDevice() = PeopleError(403, Kind.NoDevice, "no_device", NOT_ALLOWED_MESSAGE)

        /** Shown when the platform's secure store (Keychain or Keystore) cannot be reached right now (native only). */
        const val SECURE_STORE_MESSAGE = "This phone's secure storage isn't available right now. Try again in a moment."

        /**
         * Shown when a first visible write is asked for while the people records are kept in memory
         * only, because the stored data could not be opened (native only).
         */
        const val RECORDS_IN_MEMORY_MESSAGE =
            "The data saved on this phone could not be opened, so your profile can't be shared now: this phone would lose track of it when the app closes."

        /** Shown when "Delete my profile" is asked for while the people records are kept in memory only (native only). */
        const val RECORDS_IN_MEMORY_DELETE_MESSAGE =
            "The data saved on this phone could not be opened, so this phone can't tell where your profile is shared. Nothing was deleted, and this phone keeps its key so it can delete your profile once it can open its data again."

        /** The secure store failed, so nothing was sent: retried like a network failure. */
        internal fun secureStoreUnavailable() = PeopleError(0, Kind.Offline, "secure_store", SECURE_STORE_MESSAGE)

        /** A delete covers the conference: the web's 403 `delete_pending`. */
        internal fun deleteUnfinished() = PeopleError(403, Kind.DeleteUnfinished, "delete_pending", DELETE_UNFINISHED_MESSAGE)

        /** Shown when an action the backend does not offer is asked for anyway (native only). */
        const val NOT_OFFERED_MESSAGE = "This server does not offer that."

        internal fun notOffered() = PeopleError(0, Kind.NotOffered, "not_offered", NOT_OFFERED_MESSAGE)
    }
}
