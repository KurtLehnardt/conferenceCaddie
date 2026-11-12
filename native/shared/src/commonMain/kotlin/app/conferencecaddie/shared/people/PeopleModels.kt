package app.conferencecaddie.shared.people

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.nullable
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json

// The request and response bodies of People API v1, one type per `$defs` entry of
// contracts/schema/people-api.v1.schema.json. Requests are closed on the server (an unknown key is
// 400), so a request type sends exactly the keys it is given and no default values of its own; a
// key the schema allows to be absent or null is an [Opt]. Responses are read leniently: unknown keys
// are ignored, an unknown enum value reads as the property's default, and a missing optional value
// reads as null or empty.

/**
 * A request value the schema allows to be absent, `null` or a value: [Absent] sends no key at
 * all, [Null] sends `null`, and [Of] sends the value. The server tells the three apart (a presence
 * write without `until` keeps the hour mode, `linkedin_url: null` clears the link), so requests
 * spell out which one they mean.
 */
@Serializable(with = OptSerializer::class)
sealed interface Opt<out T> {
    data object Absent : Opt<Nothing>

    data object Null : Opt<Nothing>

    data class Of<out T>(val value: T) : Opt<T>

    /** The value, or null for [Absent] and [Null]. */
    val orNull: T? get() = (this as? Of<T>)?.value

    companion object {
        /** [Of] for a value, [Null] for null. */
        fun <T> of(value: T?): Opt<T> = if (value == null) Null else Of(value)

        /** [Of] for a value, [Absent] for null. */
        fun <T> orAbsent(value: T?): Opt<T> = if (value == null) Absent else Of(value)
    }
}

/** Writes [Opt.Of] as its value and [Opt.Null] as `null`; [Opt.Absent] is left out by [PeopleJson.requests]. */
class OptSerializer<T>(private val inner: KSerializer<T>) : KSerializer<Opt<T>> {
    override val descriptor: SerialDescriptor = inner.descriptor.nullable

    override fun serialize(encoder: Encoder, value: Opt<T>) {
        if (value is Opt.Of) encoder.encodeSerializableValue(inner, value.value) else encoder.encodeNull()
    }

    override fun deserialize(decoder: Decoder): Opt<T> =
        if (decoder.decodeNotNullMark()) Opt.Of(decoder.decodeSerializableValue(inner)) else decoder.decodeNull().let { Opt.Null }
}

/** The two JSON configurations of the People API. */
object PeopleJson {
    /**
     * For requests: a property equal to its default (an [Opt.Absent] or a null `ble`) is left out,
     * so nothing is sent that the caller did not set.
     */
    val requests: Json = Json {
        encodeDefaults = false
        explicitNulls = false
    }

    /** For responses and the device's own records: lenient, as the contract asks of clients. */
    val responses: Json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
        encodeDefaults = true
    }
}

// -------------------------------------------------------------------------------------------------
// Shared shapes and enums

@Serializable
data class TopicRef(
    @SerialName("topic_id") val topicId: String,
    val label: String,
)

/** Present when meaning-based matching was unavailable and keyword matching answered instead. */
@Serializable
data class Degraded(val semantic: Boolean = false)

/**
 * Present on a 200 when the filter's classifier held a line: it is stored and shown only to its
 * author until the operator clears it. [fields] names "spot", "note" or "spot_me".
 */
@Serializable
data class Held(val fields: List<String> = emptyList(), val message: String = "")

/** `{ "ok": true }`. */
@Serializable
data class OkResponse(val ok: Boolean = false)

@Serializable
enum class MatchWhen {
    @SerialName("anyone") Anyone,
    @SerialName("around_now") AroundNow,
}

/** How long presence runs: an hour, or until turned off, at the latest at the end of the conference day. */
@Serializable
enum class PresenceMode {
    @SerialName("hour") Hour,
    @SerialName("day") Day,
}

/**
 * A presence write's `until`: a mode, which restarts presence's end on the server ([PresenceMode]),
 * or `keep`, which keeps the `presence_until` the server holds, on a backend whose capabilities say
 * `people.presence_keep_until` ([app.conferencecaddie.shared.Capabilities.People.presenceKeepUntil]).
 * `keep` is for the wire only: the person picks an hour or the day, never `keep`, so [PresenceMode]
 * has no such value.
 */
@Serializable
enum class PresenceUntil {
    @SerialName("hour") Hour,
    @SerialName("day") Day,
    @SerialName("keep") Keep,
    ;

    companion object {
        /** The `until` that asks for [mode]. */
        fun of(mode: PresenceMode): PresenceUntil = when (mode) {
            PresenceMode.Hour -> Hour
            PresenceMode.Day -> Day
        }
    }
}

/**
 * How close someone who is around is, as a band only: the same zone, the same ~100 m cell, cells
 * under 300 m apart, or just the venue. Never a distance.
 */
@Serializable
enum class Proximity {
    @SerialName("same_zone") SameZone,
    @SerialName("near") Near,
    @SerialName("around") Around,
    @SerialName("venue") Venue,
}

/**
 * The state of a meet. Asks are now-only: accept moves a meet straight to [Active]. [Accepted] is a
 * legacy value the server no longer sends, and [Unknown] stands for a value this app does not know.
 */
@Serializable
enum class MeetState {
    @SerialName("requested") Requested,
    @SerialName("accepted") Accepted,
    @SerialName("declined") Declined,
    @SerialName("active") Active,
    @SerialName("found") Found,
    @SerialName("cancelled") Cancelled,
    @SerialName("expired") Expired,
    Unknown,
    ;

    /** True for the states that still wait for something to happen (the web's OPEN_STATES). */
    val isOpen: Boolean get() = this == Requested || this == Active

    companion object {
        /** The state named by [code] as the server writes it, or null. */
        fun fromCode(code: String?): MeetState? = when (code) {
            "requested" -> Requested
            "accepted" -> Accepted
            "declined" -> Declined
            "active" -> Active
            "found" -> Found
            "cancelled" -> Cancelled
            "expired" -> Expired
            else -> null
        }
    }
}

@Serializable
enum class ReportKind {
    @SerialName("profile") Profile,
    @SerialName("meet") Meet,
    @SerialName("spot") Spot,
}

@Serializable
enum class ReportReason {
    @SerialName("harassment") Harassment,
    @SerialName("hate") Hate,
    @SerialName("sexual") Sexual,
    @SerialName("spam") Spam,
    @SerialName("other") Other,
}

// -------------------------------------------------------------------------------------------------
// Profile

/** `ProfileFields`: the profile as the server stores it for one conference. */
@Serializable
data class ProfileFields(
    @SerialName("display_name") val displayName: String,
    val about: Opt<String> = Opt.Absent,
    val interests: Opt<String> = Opt.Absent,
    val expertise: Opt<String> = Opt.Absent,
    @SerialName("learn_topics") val learnTopics: Opt<List<String>> = Opt.Absent,
    @SerialName("speak_topics") val speakTopics: Opt<List<String>> = Opt.Absent,
    @SerialName("linkedin_url") val linkedinUrl: Opt<String> = Opt.Absent,
    @SerialName("contact_note") val contactNote: Opt<String> = Opt.Absent,
)

/** `ProfilePutRequest`. Both choices off with no shared talks deletes the profile. */
@Serializable
data class ProfilePutRequest(
    val event: String,
    val profile: ProfileFields,
    @SerialName("open_to_meet") val openToMeet: Boolean,
    @SerialName("shared_talk_ids") val sharedTalkIds: Opt<List<String>> = Opt.Absent,
)

@Serializable
data class ProfilePutResponse(
    val ok: Boolean = false,
    @SerialName("open_to_meet") val openToMeet: Boolean = false,
    @SerialName("shared_talk_ids") val sharedTalkIds: List<String> = emptyList(),
    /** True while the profile is hidden after reports; only its owner learns it. Absent when the write deleted the profile. */
    @SerialName("hidden_for_owner") val hiddenForOwner: Boolean? = null,
    val degraded: Degraded? = null,
)

// -------------------------------------------------------------------------------------------------
// Matches and circles

@Serializable
data class Contact(
    @SerialName("linkedin_url") val linkedinUrl: String? = null,
    @SerialName("contact_note") val contactNote: String? = null,
)

/**
 * `Person`: one result of matches or circle members. Read [zone] and [proximity] only through
 * [PeoplePrivacy], which applies the contract's rules.
 */
@Serializable
data class Person(
    val ref: String,
    @SerialName("display_name") val displayName: String,
    val about: String? = null,
    val sample: Boolean = false,
    @SerialName("learn_topics") val learnTopics: List<TopicRef> = emptyList(),
    @SerialName("speak_topics") val speakTopics: List<TopicRef> = emptyList(),
    val reasons: List<String> = emptyList(),
    val opener: String? = null,
    val contact: Contact? = null,
    /** The matched passage; `<mark>` is the only markup, everything else HTML-escaped. */
    val evidence: String? = null,
    val around: Boolean = false,
    val zone: String? = null,
    val proximity: Proximity? = null,
    /** A broad match: found only through a common topic, so it carries no evidence. */
    val broad: Boolean = false,
)

@Serializable
data class MatchesRequest(
    val event: String,
    @SerialName("interested_talk_ids") val interestedTalkIds: Opt<List<String>> = Opt.Absent,
    val query: Opt<String> = Opt.Absent,
    @SerialName("when") val whenNow: Opt<MatchWhen> = Opt.Absent,
    val from: Opt<Int> = Opt.Absent,
    val size: Opt<Int> = Opt.Absent,
)

@Serializable
data class MatchesResponse(
    val results: List<Person> = emptyList(),
    val from: Int = 0,
    val size: Int = 20,
    @SerialName("has_more") val hasMore: Boolean = false,
    val degraded: Degraded? = null,
)

@Serializable
data class CircleCountsRequest(
    val event: String,
    @SerialName("talk_ids") val talkIds: Opt<List<String>> = Opt.Absent,
)

@Serializable
data class CircleCountsResponse(val counts: Map<String, Int> = emptyMap())

@Serializable
data class CircleMembersRequest(
    val event: String,
    @SerialName("talk_id") val talkId: String,
)

@Serializable
data class SpeakerLink(val title: String = "", val url: String = "")

@Serializable
data class SpeakerProfile(
    val name: String = "",
    val tagline: String? = null,
    val links: List<SpeakerLink> = emptyList(),
)

@Serializable
data class CircleTalk(
    val title: String = "",
    val start: String? = null,
    val end: String? = null,
    val url: String? = null,
)

@Serializable
data class CircleMembersResponse(
    val talk: CircleTalk = CircleTalk(),
    val speakers: List<SpeakerProfile> = emptyList(),
    val count: Int = 0,
    val members: List<Person> = emptyList(),
)

// -------------------------------------------------------------------------------------------------
// Blocks

@Serializable
data class BlockRequest(val event: String, val ref: String)

@Serializable
data class BlockEntry(
    val ref: String,
    /** Null when the blocked profile is gone or its delete is pending. */
    @SerialName("display_name") val displayName: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class BlocksResponse(
    val refs: List<String> = emptyList(),
    val blocks: List<BlockEntry>? = null,
)

// -------------------------------------------------------------------------------------------------
// Presence and Bluetooth

/** A position as sent with presence: degrees and the accuracy in whole metres. */
@Serializable
data class PresenceLocation(val lat: Double, val lon: Double, val accuracy: Long)

@Serializable
data class PresencePutRequest(
    val event: String,
    val zone: String,
    val spot: Opt<String> = Opt.Absent,
    val location: Opt<PresenceLocation> = Opt.Absent,
    val until: Opt<PresenceUntil> = Opt.Absent,
    /** true starts Bluetooth proximity, false stops it, null (absent) leaves it as it is. */
    val ble: Boolean? = null,
)

/** server-rotate mode only (legacy): the token to advertise until [rotateAt]. */
@Serializable
data class LegacyBleToken(
    val token: String,
    @SerialName("rotate_at") val rotateAt: String,
) {
    override fun toString(): String = "LegacyBleToken(rotateAt=$rotateAt)"
}

/**
 * The answer to a presence write. [bleKey] is secret material (derived-v1): it is kept out of
 * [toString] and must only go to the Keystore or Keychain.
 */
@Serializable
data class PresencePutResponse(
    val ok: Boolean = false,
    val zone: String = "",
    val spot: String? = null,
    @SerialName("spot_hidden") val spotHidden: Boolean = false,
    /** The mode the server holds; anything else (a `keep` echoed back, say) reads as null. */
    val until: PresenceMode? = null,
    @SerialName("presence_since") val presenceSince: String? = null,
    @SerialName("presence_until") val presenceUntil: String? = null,
    val located: Boolean = false,
    val ble: LegacyBleToken? = null,
    @SerialName("ble_key") val bleKey: String? = null,
    @SerialName("ble_key_id") val bleKeyId: String? = null,
    val held: Held? = null,
) {
    override fun toString(): String =
        "PresencePutResponse(ok=$ok, zone=$zone, spot=$spot, spotHidden=$spotHidden, until=$until, presenceSince=$presenceSince, " +
            "presenceUntil=$presenceUntil, located=$located, ble=$ble, bleKey=${if (bleKey == null) "null" else "<redacted>"}, " +
            "bleKeyId=$bleKeyId, held=$held)"
}

@Serializable
data class BleRotateRequest(val event: String)

@Serializable
data class BleRotateResponse(val ok: Boolean = false, val ble: LegacyBleToken? = null)

@Serializable
data class Sighting(val token: String, val rssi: Int)

@Serializable
data class SightingsRequest(val event: String, val sightings: List<Sighting>)

@Serializable
data class NearbyPerson(
    val ref: String,
    @SerialName("display_name") val displayName: String = "",
    val evidence: String? = null,
    @SerialName("speak_topics") val speakTopics: List<TopicRef> = emptyList(),
    val zone: String? = null,
)

@Serializable
data class SightingsResponse(
    @SerialName("ble_key_id") val bleKeyId: String? = null,
    val nearby: List<NearbyPerson> = emptyList(),
)

// -------------------------------------------------------------------------------------------------
// Meets

@Serializable
data class MeetRequest(
    val event: String,
    val ref: String,
    @SerialName("topic_id") val topicId: Opt<String> = Opt.Absent,
    val note: Opt<String> = Opt.Absent,
)

@Serializable
data class MeetDetailsRequest(
    @SerialName("spot_me") val spotMe: Opt<String> = Opt.Absent,
    val rendezvous: Opt<String> = Opt.Absent,
)

/** Meet actions take an empty JSON object. */
@Serializable
class EmptyRequest

@Serializable
data class MeetMine(
    @SerialName("spot_me") val spotMe: String? = null,
    val around: Boolean = false,
)

/**
 * The other participant of a meet. [distanceM] and [bearingDeg] are kept only on a meet read
 * ([MeetRead]); every other answer drops them. Read the zone, spot lines and distance only through
 * [PeoplePrivacy].
 */
@Serializable
data class MeetOther(
    val ref: String? = null,
    @SerialName("display_name") val displayName: String = "",
    val about: String = "",
    val around: Boolean = false,
    val zone: String? = null,
    val spot: String? = null,
    @SerialName("spot_me") val spotMe: String? = null,
    @SerialName("distance_m") val distanceM: Int? = null,
    @SerialName("bearing_deg") val bearingDeg: Int? = null,
)

@Serializable
data class MeetFrom(
    val ref: String,
    @SerialName("display_name") val displayName: String = "",
    val about: String? = null,
)

@Serializable
data class MeetTo(
    val ref: String,
    @SerialName("display_name") val displayName: String = "",
)

/** `MeetView`: the meet shape, plus the keys a route adds (held on actions, from or to in the inbox). */
@Serializable
data class MeetView(
    @SerialName("meet_id") val meetId: String,
    val state: MeetState = MeetState.Unknown,
    @SerialName("requested_by_me") val requestedByMe: Boolean = false,
    @SerialName("same_zone") val sameZone: Boolean = false,
    val topic: TopicRef? = null,
    @SerialName("topic_label") val topicLabel: String? = null,
    val note: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("active_since") val activeSince: String? = null,
    @SerialName("active_until") val activeUntil: String? = null,
    @SerialName("expires_at") val expiresAt: String? = null,
    val rendezvous: String? = null,
    val mine: MeetMine = MeetMine(),
    val other: MeetOther = MeetOther(),
    val held: Held? = null,
    val from: MeetFrom? = null,
    val to: MeetTo? = null,
) {
    /** This meet without a distance or bearing, for every answer except a meet read. */
    internal fun withoutDistance(): MeetView =
        if (other.distanceM == null && other.bearingDeg == null) this else copy(other = other.copy(distanceM = null, bearingDeg = null))
}

/**
 * The answer of `GET /api/meet/{meet_id}`, the only one that may carry a distance and a bearing.
 * [PeoplePrivacy.distance] reads them, and only while the meet is active.
 */
data class MeetRead(val meet: MeetView)

@Serializable
data class InboxResponse(
    val incoming: List<MeetView> = emptyList(),
    val outgoing: List<MeetView> = emptyList(),
)

// -------------------------------------------------------------------------------------------------
// Reports

@Serializable
data class ReportContext(val kind: ReportKind, val id: String)

@Serializable
data class ReportRequest(
    val event: String,
    val ref: String,
    val context: ReportContext,
    val reason: ReportReason,
)

@Serializable
data class ReportResponse(val ok: Boolean = false, val hidden: Boolean = false)

// -------------------------------------------------------------------------------------------------
// Push

@Serializable
data class PushVapidResponse(val publicKey: String? = null)

@Serializable
data class PushKeys(val p256dh: String, val auth: String)

@Serializable
data class PushSubscriptionBody(
    val endpoint: String,
    val keys: PushKeys,
    val expirationTime: Opt<Double> = Opt.Absent,
)

@Serializable
data class PushSubscriptionPutRequest(val event: String, val subscription: PushSubscriptionBody)

@Serializable
data class PushSubscriptionDeleteRequest(val event: String, val endpoint: String)

/**
 * The native push registration of the official backend ([NativePush]): [platform] is "apns" or
 * "fcm"; [environment] ("production" or "sandbox") is sent for APNs only. The token never reaches
 * [toString].
 */
@Serializable
data class NativePushPutRequest(
    val event: String,
    val platform: String,
    val token: String,
    val environment: String? = null,
) {
    override fun toString(): String = "NativePushPutRequest(event=$event, platform=$platform, token=<redacted>, environment=$environment)"
}

@Serializable
data class NativePushDeleteRequest(val event: String, val platform: String, val token: String) {
    override fun toString(): String = "NativePushDeleteRequest(event=$event, platform=$platform, token=<redacted>)"
}
