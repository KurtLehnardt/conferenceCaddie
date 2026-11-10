package app.conferencecaddie.shared

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Placeholder models. The real shapes come from the talk bundle v1 contract in Phase 1; these exist
// so the UI skeleton has something typed to render.

@Serializable
data class Conference(
    val id: String,
    val name: String,
)

@Serializable
data class Talk(
    val id: String,
    val title: String,
    val speakers: List<String> = emptyList(),
    /** ISO 8601 start time with offset, as in today's schedule data. */
    @SerialName("starts_at") val startsAt: String? = null,
    val room: String? = null,
    val topics: List<String> = emptyList(),
)
