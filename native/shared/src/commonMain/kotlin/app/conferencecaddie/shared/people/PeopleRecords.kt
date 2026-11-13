package app.conferencecaddie.shared.people

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// The device-side records of the people features, as web/src/people/storage.ts keeps them (types.ts
// names them). They are immutable values: the screens read them from PeopleUiState, and only the
// controller writes them, through PeopleStore. Each is stored as JSON in PeopleDatabase, a file
// that no backup carries, under keys scoped by the normalised backend base (and the conference slug
// where the web scopes by slug).

/** The topics chosen for one conference. */
@Serializable
data class ConferenceTopics(
    val learn: List<TopicRef> = emptyList(),
    val speak: List<TopicRef> = emptyList(),
)

/** The profile on this device (caddie.profile.v1): one per backend, with topic choices per conference. */
@Serializable
data class Profile(
    @SerialName("display_name") val displayName: String = "",
    val about: String = "",
    val interests: String = "",
    val expertise: String = "",
    @SerialName("linkedin_url") val linkedinUrl: String = "",
    @SerialName("contact_note") val contactNote: String = "",
    /** Topic choices per conference slug. */
    val topics: Map<String, ConferenceTopics> = emptyMap(),
) {
    /** The topics of conference [slug]. */
    fun topicsFor(slug: String): ConferenceTopics = topics[slug] ?: ConferenceTopics()

    internal fun sanitized(): Profile = Profile(
        displayName = displayName.take(60),
        about = about.take(280),
        interests = interests.take(500),
        expertise = expertise.take(500),
        linkedinUrl = linkedinUrl.take(200),
        contactNote = contactNote.take(120),
        topics = topics.mapValues { (_, t) -> ConferenceTopics(t.learn.take(30), t.speak.take(30)) },
    )

    companion object {
        val EMPTY = Profile()
    }
}

/** The visibility choices of one conference (caddie.visibility.v1.{slug}). */
@Serializable
data class Visibility(
    @SerialName("open_to_meet") val openToMeet: Boolean = false,
    @SerialName("shared_talk_ids") val sharedTalkIds: List<String> = emptyList(),
    /** True once the server holds a document for this conference. */
    @SerialName("on_server") val onServer: Boolean = false,
    /**
     * True from the moment a first write for this conference is sent until the server answers it:
     * if the answer never arrives, the server may hold a document all the same.
     */
    @SerialName("maybe_on_server") val maybeOnServer: Boolean = false,
    @SerialName("share_notice_seen") val shareNoticeSeen: Boolean = false,
    /** Ended talks whose banner the user has already seen or closed. */
    @SerialName("banner_seen") val bannerSeen: List<String> = emptyList(),
    /** Device-only: sharing follows the Interested list. Off by default. */
    @SerialName("share_new") val shareNew: Boolean = false,
    /** True when the server last said this profile is hidden after reports (its owner still sees it). */
    @SerialName("hidden_for_owner") val hiddenForOwner: Boolean = false,
) {
    /** True when either choice asks the server to hold the profile. */
    val wantsServer: Boolean get() = openToMeet || sharedTalkIds.isNotEmpty()

    internal fun sanitized(): Visibility = copy(sharedTalkIds = sharedTalkIds.take(50), bannerSeen = bannerSeen.takeLast(200))
}

/** "Use my position too", asked once per conference. */
@Serializable
enum class PositionChoice {
    @SerialName("yes") Yes,
    @SerialName("no") No,
}

/** Presence on this device (caddie.presence.v1.{slug}). */
@Serializable
data class Presence(
    val on: Boolean = false,
    val zone: String? = null,
    val spot: String = "",
    /** ISO time when presence turns off by itself; null while off. */
    val until: String? = null,
    @SerialName("notice_seen") val noticeSeen: Boolean = false,
    /** GPS bands: true while the device also sends its position with presence. */
    val position: Boolean = false,
    /** The answer to "Use my position too"; null until answered. */
    @SerialName("position_choice") val positionChoice: PositionChoice? = null,
    val mode: PresenceMode = PresenceMode.Hour,
    /** ISO time the zone was last chosen, confirmed or dismissed; null while off. */
    @SerialName("confirmed_at") val confirmedAt: String? = null,
    /** True once the app came back to the foreground with a zone older than ten minutes: "Still in {zone}?". */
    @SerialName("confirm_pending") val confirmPending: Boolean = false,
    /** Zones chosen on this device, most recent first, for ordering the "Still in" chips. */
    @SerialName("recent_zones") val recentZones: List<String> = emptyList(),
    /** True when the server hid the spot line after reports, so it is not stored. */
    @SerialName("spot_hidden") val spotHidden: Boolean = false,
    /** The filter's hold on the spot line from the last write, if any: shown only to its author. */
    val held: Held? = null,
)

/** Native push nudges for one conference: whether the backend holds this device's token. */
@Serializable
data class PushRecord(
    val on: Boolean = false,
    /** "apns" or "fcm", while [on]. */
    val platform: String? = null,
    /** The registered token, so it can be removed by name; null while off. */
    val token: String? = null,
    @SerialName("notice_seen") val noticeSeen: Boolean = false,
) {
    override fun toString(): String = "PushRecord(on=$on, platform=$platform, noticeSeen=$noticeSeen)"
}

/**
 * Bluetooth proximity at one conference (web ble.ts keeps `caddie.ble.v1.{slug}`). The session key
 * itself is never here: it lives in the platform's [app.conferencecaddie.shared.ble.BleKeyStore],
 * and [keyId] only names it, so a sightings answer that names another key can be recognised.
 */
@Serializable
internal data class BleRecord(
    /** The device's switch: true from a successful turn-on until it is turned or stopped off. */
    val on: Boolean = false,
    /** True once the first-time explanation was accepted, which a successful turn-on implies. */
    @SerialName("notice_seen") val noticeSeen: Boolean = false,
    /** The `ble_key_id` of the key in the key store while [on]; null otherwise. */
    @SerialName("key_id") val keyId: String? = null,
    /** The token window of the last successful re-key, so a second one in the same window is refused. */
    @SerialName("rekey_w") val rekeyW: Long? = null,
    /** Epoch milliseconds of the nearby notifications shown in the last hour, oldest first. */
    @SerialName("notified_at") val notifiedAt: List<Long> = emptyList(),
)

/** One blocked person, cached on the device; [ref] is a key only and never shown. */
@Serializable
data class BlockedPerson(
    val ref: String,
    @SerialName("display_name") val displayName: String? = null,
)

/** Someone saved after a meet (caddie.met.v1.{slug}); device-only, kept after "Delete my profile". */
@Serializable
data class MetPerson(
    @SerialName("display_name") val displayName: String,
    val about: String = "",
    @SerialName("met_at") val metAt: String = "",
)

/** "Tell me when they're around" (caddie.watch.v1.{slug}); device-only. */
@Serializable
data class Watch(
    val ref: String,
    @SerialName("display_name") val displayName: String = "",
    /** ISO time the watch was set. */
    val since: String = "",
)

/** How a profile delete failed, as far as the user is concerned. */
@Serializable
enum class DeleteFailure {
    @SerialName("partial") Partial,
    @SerialName("offline") Offline,
    @SerialName("store") Store,
    @SerialName("rate") Rate,
    @SerialName("forbidden") Forbidden,
    @SerialName("bad") Bad,
}

/**
 * A profile delete the server has not confirmed yet, for one conference or "Delete my profile" as
 * a whole. While one is stored, no profile write it covers is sent, and the delete is tried again.
 */
@Serializable
data class DeleteRetry(
    /** Failed attempts so far; they set how long the next automatic attempt waits. */
    val attempts: Int = 0,
    /** Epoch milliseconds before which no automatic attempt is sent; 0 for at once. */
    @SerialName("next_at") val nextAt: Long = 0,
    /** Attempts in a row that the server refused this device's key (403 forbidden). */
    val forbidden: Int = 0,
    /** How the last attempt failed, or null before the first failure. */
    val last: DeleteFailure? = null,
    /** Epoch milliseconds the delete was first asked for. */
    val since: Long = 0,
    /**
     * "Delete my profile" only: true once a pass has marked every conference of the backend's list
     * that had not ended, so later passes send only to those still unconfirmed.
     */
    @SerialName("list_reached") val listReached: Boolean = false,
)

/** Everything the device keeps for one conference of one backend, stored as one JSON value. */
@Serializable
internal data class ConferenceRecord(
    val visibility: Visibility = Visibility(),
    val presence: Presence = Presence(),
    val push: PushRecord = PushRecord(),
    val blocks: List<BlockedPerson> = emptyList(),
    val met: List<MetPerson> = emptyList(),
    val watch: List<Watch> = emptyList(),
    /** ref to the local date ("2026-11-10") it was last nudged about; today's entries only. */
    val nudged: Map<String, String> = emptyMap(),
    /** Whether nudges are wanted at this conference; on by default. */
    @SerialName("nudges_on") val nudgesOn: Boolean = true,
    @SerialName("delete_pending") val deletePending: DeleteRetry? = null,
    /** Bluetooth proximity's switch and bookkeeping at this conference. */
    val ble: BleRecord = BleRecord(),
    /**
     * True when this is a demo conference, kept when presence or Bluetooth turns on, so a
     * notification about it says so even while the conference list is not loaded.
     */
    val demo: Boolean = false,
) {
    internal fun sanitized(): ConferenceRecord = copy(
        visibility = visibility.sanitized(),
        presence = presence.copy(zone = presence.zone?.take(120), spot = presence.spot.take(60), recentZones = presence.recentZones.take(8)),
        blocks = blocks.take(500),
        met = met.takeLast(500),
        watch = watch.takeLast(200),
        ble = ble.copy(notifiedAt = ble.notifiedAt.takeLast(10)),
    )

    /** True when nothing but defaults is left, so the record can be removed; the demo mark alone keeps nothing. */
    internal val isEmpty: Boolean get() = copy(demo = false) == ConferenceRecord()
}
