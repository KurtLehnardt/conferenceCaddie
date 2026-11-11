package app.conferencecaddie.shared.people

import kotlin.math.roundToLong
import kotlin.time.Clock

/**
 * Request pacing (web/src/lib/pace.ts). The API reports how close it is to its daily request
 * budget in an `X-Caddie-Pace` header, from 1 (normal) to 10. Every poll interval is multiplied by
 * it, so the app slows its background requests down before the daily cap is reached. Calls the
 * person makes themselves are never delayed. The value decays back to 1 after 30 minutes without
 * news.
 */
class Pace(private val clock: Clock) {
    private var pace = MIN_PACE
    private var seenAt = 0L

    /** Reads the pace from an answer's header value. A missing or malformed value changes nothing. */
    fun note(header: String?) {
        if (header == null) return
        val value = header.trim().toDoubleOrNull() ?: return
        if (!value.isFinite()) return
        pace = value.coerceIn(MIN_PACE, MAX_PACE)
        seenAt = clock.now().toEpochMilliseconds()
    }

    /** The pace now: the latest reported value, or 1 once it is older than 30 minutes. */
    fun current(): Double {
        if (pace != MIN_PACE && clock.now().toEpochMilliseconds() - seenAt > DECAY_MS) pace = MIN_PACE
        return pace
    }

    /** A poll interval stretched by the pace. */
    fun pacedMs(ms: Long): Long = (ms * current()).roundToLong()

    /** The open-meet poll is stretched by at most 3, because a live meet is time-sensitive. */
    fun pacedMeetMs(ms: Long): Long = (ms * minOf(current(), 3.0)).roundToLong()

    companion object {
        const val MIN_PACE = 1.0
        const val MAX_PACE = 10.0
        const val DECAY_MS = 30 * 60_000L
    }
}
