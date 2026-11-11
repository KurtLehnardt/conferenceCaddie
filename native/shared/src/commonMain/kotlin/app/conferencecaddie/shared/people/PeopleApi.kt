package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.asInteger
import app.conferencecaddie.shared.asObject
import app.conferencecaddie.shared.asString
import app.conferencecaddie.shared.net.ApiHttp
import app.conferencecaddie.shared.net.HttpResponse
import app.conferencecaddie.shared.net.RequestTimeout
import app.conferencecaddie.shared.net.ResponseTooLarge
import kotlin.time.Clock
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.Json

/** The outcome of one People API call: the decoded answer, or the error the contract's client rule maps it to. */
sealed interface ApiResult<out T> {
    data class Ok<out T>(val value: T) : ApiResult<T>

    data class Failed(val error: PeopleError) : ApiResult<Nothing>

    /** The value, or null when the call failed. */
    val valueOrNull: T? get() = (this as? Ok<T>)?.value

    /** The error, or null when the call succeeded. */
    val errorOrNull: PeopleError? get() = (this as? Failed)?.error
}

/**
 * The People API v1 client (docs/contracts/people-api.md), one suspend function per route of
 * contracts/routes/people-api.v1.json, plus the native push registration the server adds for the
 * official backend.
 *
 * - Device routes send `X-Caddie-Device` from [device], and only when the credential belongs to
 *   [backend]; without one nothing is sent and the call fails with [PeopleError.Kind.NoDevice].
 * - The conference goes in the body, or as `?event=` for the `GET` and `DELETE` routes without a
 *   body; the routes under `/api/meet/{meet_id}` find it from the meet.
 * - No `Origin` and no cookies are ever sent ([ApiHttp]).
 * - Profile writes and deletes and the presence delete wait at most [WRITE_TIMEOUT_MS] for their
 *   answer, as on the web; every other request at most [REQUEST_TIMEOUT_MS].
 * - A free-text 409 ("The profile changed at the same time; try again", "The meet changed at the
 *   same time; try again") is retried once on the routes the route table says to, and on the meet
 *   actions, as the contract's client rule allows.
 * - Every answer's `X-Caddie-Pace` goes to [pace].
 */
class PeopleApi(
    private val http: ApiHttp,
    val backend: BackendUrl.Valid,
    private val device: suspend () -> DeviceCredential?,
    val pace: Pace,
    private val clock: Clock = Clock.System,
) {
    // ---------------------------------------------------------------------------------------------
    // Profile, matches and circles

    /** `PUT /api/people/profile`: create or update; both choices off with no shared talks deletes it. */
    suspend fun putProfile(request: ProfilePutRequest): ApiResult<ProfilePutResponse> =
        call("PUT", "/api/people/profile", encode(ProfilePutRequest.serializer(), request), ProfilePutResponse.serializer(), WRITE_TIMEOUT_MS, retryConflict = true)

    /** `DELETE /api/people/profile?event=`: deletes the profile and everything connected to it; 200 when there is nothing. */
    suspend fun deleteProfile(event: String): ApiResult<OkResponse> =
        call("DELETE", "/api/people/profile?event=${encodeQuery(event)}", null, OkResponse.serializer(), WRITE_TIMEOUT_MS)

    /** `POST /api/people/matches`: people to meet, a text search, and (when around_now) who is around. */
    suspend fun matches(request: MatchesRequest): ApiResult<MatchesResponse> =
        call("POST", "/api/people/matches", encode(MatchesRequest.serializer(), request), MatchesResponse.serializer())

    /** `POST /api/circles/counts`: how many people share for each talk; no device header. */
    suspend fun circleCounts(request: CircleCountsRequest): ApiResult<CircleCountsResponse> =
        call("POST", "/api/circles/counts", encode(CircleCountsRequest.serializer(), request), CircleCountsResponse.serializer(), auth = false)

    /** `POST /api/circles/members`: who shares for a talk, for a requester who shares for it too. */
    suspend fun circleMembers(request: CircleMembersRequest): ApiResult<CircleMembersResponse> =
        call("POST", "/api/circles/members", encode(CircleMembersRequest.serializer(), request), CircleMembersResponse.serializer())

    // ---------------------------------------------------------------------------------------------
    // Blocks

    /** `POST /api/people/block`: symmetric; ends any open meet between the two. */
    suspend fun block(request: BlockRequest): ApiResult<OkResponse> =
        call("POST", "/api/people/block", encode(BlockRequest.serializer(), request), OkResponse.serializer())

    /** `DELETE /api/people/block`: lifts the requester's block of a ref, whether or not that profile still exists. */
    suspend fun unblock(request: BlockRequest): ApiResult<OkResponse> =
        call("DELETE", "/api/people/block", encode(BlockRequest.serializer(), request), OkResponse.serializer())

    /** `GET /api/people/blocks?event=`: the requester's blocks, newest first. */
    suspend fun blocks(event: String): ApiResult<BlocksResponse> =
        call("GET", "/api/people/blocks?event=${encodeQuery(event)}", null, BlocksResponse.serializer())

    // ---------------------------------------------------------------------------------------------
    // Presence and Bluetooth

    /** `PUT /api/presence`: zone, spot line, optional position, hour or day, and optionally Bluetooth. */
    suspend fun putPresence(request: PresencePutRequest): ApiResult<PresencePutResponse> =
        call("PUT", "/api/presence", encode(PresencePutRequest.serializer(), request), PresencePutResponse.serializer(), retryConflict = true)

    /** `DELETE /api/presence?event=`: ends presence, the position and Bluetooth, and expires any active meet. */
    suspend fun deletePresence(event: String): ApiResult<OkResponse> =
        call("DELETE", "/api/presence?event=${encodeQuery(event)}", null, OkResponse.serializer(), WRITE_TIMEOUT_MS)

    /** `POST /api/presence/ble/rotate`: legacy `server-rotate` mode only; this app never calls it in derived-v1. */
    suspend fun rotateBle(request: BleRotateRequest): ApiResult<BleRotateResponse> =
        call("POST", "/api/presence/ble/rotate", encode(BleRotateRequest.serializer(), request), BleRotateResponse.serializer(), retryConflict = true)

    /** `POST /api/presence/sightings`: which heard tokens belong to strong matches right here. */
    suspend fun sightings(request: SightingsRequest): ApiResult<SightingsResponse> =
        call("POST", "/api/presence/sightings", encode(SightingsRequest.serializer(), request), SightingsResponse.serializer())

    // ---------------------------------------------------------------------------------------------
    // Meets

    /** `POST /api/meet`: ask to talk shop, now. A Wave is the same request with a note the client writes. */
    suspend fun requestMeet(request: MeetRequest): ApiResult<MeetView> =
        call("POST", "/api/meet", encode(MeetRequest.serializer(), request), MeetView.serializer()).map { it.withoutDistance() }

    /** `GET /api/meet/inbox?event=`: open asks to and from the requester, newest first. */
    suspend fun inbox(event: String): ApiResult<InboxResponse> =
        call("GET", "/api/meet/inbox?event=${encodeQuery(event)}", null, InboxResponse.serializer())
            .map { r -> InboxResponse(r.incoming.map { it.withoutDistance() }, r.outgoing.map { it.withoutDistance() }) }

    /** `GET /api/meet/{meet_id}`: one meet, the only answer with a distance and a bearing. */
    suspend fun readMeet(meetId: String): ApiResult<MeetRead> =
        call("GET", "/api/meet/${encodeQuery(meetId)}", null, MeetView.serializer()).map { MeetRead(it) }

    /** `POST /api/meet/{meet_id}/accept`: the person asked accepts, now. */
    suspend fun acceptMeet(meetId: String): ApiResult<MeetView> = meetAction(meetId, "accept")

    /** `POST /api/meet/{meet_id}/decline`: not now; the requester never learns it. */
    suspend fun declineMeet(meetId: String): ApiResult<MeetView> = meetAction(meetId, "decline")

    /** `POST /api/meet/{meet_id}/found`: either participant, active meets. */
    suspend fun foundMeet(meetId: String): ApiResult<MeetView> = meetAction(meetId, "found")

    /** `POST /api/meet/{meet_id}/cancel`: either participant, any open state. */
    suspend fun cancelMeet(meetId: String): ApiResult<MeetView> = meetAction(meetId, "cancel")

    /** `PUT /api/meet/{meet_id}/details`: my spot-me line and the meeting point, while the meet is open. */
    suspend fun putMeetDetails(meetId: String, request: MeetDetailsRequest): ApiResult<MeetView> =
        call("PUT", "/api/meet/${encodeQuery(meetId)}/details", encode(MeetDetailsRequest.serializer(), request), MeetView.serializer(), retryConflict = true)
            .map { it.withoutDistance() }

    private suspend fun meetAction(meetId: String, action: String): ApiResult<MeetView> =
        call("POST", "/api/meet/${encodeQuery(meetId)}/$action", EMPTY_BODY, MeetView.serializer(), retryConflict = true).map { it.withoutDistance() }

    // ---------------------------------------------------------------------------------------------
    // Reports and push

    /** `POST /api/people/report`: two reports hide a target from everyone but its owner. */
    suspend fun report(request: ReportRequest): ApiResult<ReportResponse> =
        call("POST", "/api/people/report", encode(ReportRequest.serializer(), request), ReportResponse.serializer())

    /** `GET /api/push/vapid`: the Web Push key, null when Web Push is off. The native apps do not use Web Push. */
    suspend fun vapidKey(): ApiResult<PushVapidResponse> =
        call("GET", "/api/push/vapid", null, PushVapidResponse.serializer(), auth = false)

    /** `PUT /api/push/subscription`: a browser's Web Push subscription. Part of the contract; unused by the native apps. */
    suspend fun putPushSubscription(request: PushSubscriptionPutRequest): ApiResult<OkResponse> =
        call("PUT", "/api/push/subscription", encode(PushSubscriptionPutRequest.serializer(), request), OkResponse.serializer())

    /** `DELETE /api/push/subscription`: removes a Web Push subscription; 200 either way. */
    suspend fun deletePushSubscription(request: PushSubscriptionDeleteRequest): ApiResult<OkResponse> =
        call("DELETE", "/api/push/subscription", encode(PushSubscriptionDeleteRequest.serializer(), request), OkResponse.serializer())

    /** Registers this device's APNs or FCM token for the requester's profile at one conference ([NativePush]). */
    suspend fun putNativePush(request: NativePushPutRequest): ApiResult<OkResponse> =
        call(NativePush.PUT_METHOD, NativePush.PATH, encode(NativePushPutRequest.serializer(), request), OkResponse.serializer())

    /** Removes this device's native push token for one conference. */
    suspend fun deleteNativePush(request: NativePushDeleteRequest): ApiResult<OkResponse> =
        call(NativePush.DELETE_METHOD, NativePush.PATH, encode(NativePushDeleteRequest.serializer(), request), OkResponse.serializer())

    // ---------------------------------------------------------------------------------------------

    private suspend fun <T> call(
        method: String,
        path: String,
        body: ByteArray?,
        response: DeserializationStrategy<T>,
        timeoutMs: Long = REQUEST_TIMEOUT_MS,
        auth: Boolean = true,
        retryConflict: Boolean = false,
    ): ApiResult<T> {
        val headers = LinkedHashMap<String, String>()
        if (auth) {
            // A secure store that cannot be read now is not a missing credential: the call fails like
            // one that got no answer, so no caller takes it for "this device has no profile".
            val credential = try {
                device()
            } catch (e: SecureStoreUnavailable) {
                return ApiResult.Failed(PeopleError.secureStoreUnavailable())
            }
            if (credential == null || credential.backendBase != backend.base) return ApiResult.Failed(PeopleError.noDevice())
            headers[DEVICE_HEADER] = credential.header()
        }
        headers["Accept"] = "application/json"
        var attempt = 0
        while (true) {
            val answer = try {
                http.send(method, backend.base + path, headers, body, timeoutMs, MAX_RESPONSE_BYTES)
            } catch (e: CancellationException) {
                throw e
            } catch (e: RequestTimeout) {
                return ApiResult.Failed(PeopleError.timeout())
            } catch (e: ResponseTooLarge) {
                return ApiResult.Failed(PeopleError.badResponse(0))
            } catch (e: Exception) {
                return ApiResult.Failed(PeopleError.offline())
            }
            pace.note(answer.header(PACE_HEADER))
            if (answer.status in 200..299) {
                return try {
                    ApiResult.Ok(json.decodeFromString(response, answer.text()))
                } catch (e: Exception) {
                    ApiResult.Failed(PeopleError.badResponse(answer.status))
                }
            }
            val error = errorOf(answer)
            if (retryConflict && attempt == 0 && error.kind == PeopleError.Kind.Conflict) {
                attempt++
                continue
            }
            return ApiResult.Failed(error)
        }
    }

    private fun errorOf(answer: HttpResponse): PeopleError {
        val o = try {
            json.parseToJsonElement(answer.text()).asObject()
        } catch (e: Exception) {
            null
        }
        return PeopleError.fromAnswer(
            status = answer.status,
            code = o?.get("error").asString(),
            serverMessage = o?.get("message").asString()?.take(200),
            count = o?.get("count").asInteger()?.toInt(),
            meetId = o?.get("meet_id").asString(),
            state = o?.get("state").asString(),
            retryAt = o?.get("retry_at").asString(),
            retryAfter = answer.header("Retry-After"),
            nowMs = clock.now().toEpochMilliseconds(),
        )
    }

    private fun <T> encode(serializer: SerializationStrategy<T>, value: T): ByteArray =
        PeopleJson.requests.encodeToString(serializer, value).encodeToByteArray()

    /** The routes and the header names, as the contract spells them. */
    companion object {
        const val DEVICE_HEADER = "X-Caddie-Device"
        const val PACE_HEADER = "X-Caddie-Pace"

        /** How long a profile write or delete (and a presence delete) waits for the answer, as on the web. */
        const val WRITE_TIMEOUT_MS = 20_000L

        /** How long any other request waits for its answer. */
        const val REQUEST_TIMEOUT_MS = 30_000L

        /** No People API answer comes near this; the largest is a page of 20 people. */
        const val MAX_RESPONSE_BYTES = 1L * 1024 * 1024

        private val EMPTY_BODY = "{}".encodeToByteArray()
        private val json: Json = PeopleJson.responses

        /** Percent-encodes a query value or a path segment, as `encodeURIComponent` does. */
        fun encodeQuery(value: String): String = buildString {
            for (b in value.encodeToByteArray()) {
                val c = b.toInt() and 0xff
                val ch = c.toChar()
                if (ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch in "-_.!~*'()") {
                    append(ch)
                } else {
                    append('%')
                    append("0123456789ABCDEF"[c shr 4])
                    append("0123456789ABCDEF"[c and 0xf])
                }
            }
        }
    }
}

/**
 * The native push registration route of the official backend: `PUT` with
 * `{ event, platform, token, environment? }` (`environment` for APNs only, "production" or
 * "sandbox"; the server refuses it with FCM) and `DELETE` with `{ event, platform, token }`, both
 * device-authenticated and answering `{ ok: true }`. A `PUT` answers 404 `push_unavailable` when the
 * server does not push to that platform, which the app treats like a server without the route: no
 * native push there. Everything that depends on the route's shape is here and in
 * [NativePushPutRequest] and [NativePushDeleteRequest].
 */
object NativePush {
    const val PATH = "/api/push/native"
    const val PUT_METHOD = "PUT"
    const val DELETE_METHOD = "DELETE"

    private val APNS_TOKEN = Regex("^(?:[0-9A-Fa-f]{2}){32,100}$")
    private val FCM_TOKEN = Regex("^[A-Za-z0-9_:-]{32,4096}$")

    /** True when [token] has the form the server accepts for [platform]: 64 to 200 hex digits for APNs, the FCM alphabet otherwise. */
    fun validToken(platform: String, token: String): Boolean = when (platform) {
        "apns" -> APNS_TOKEN.matches(token)
        "fcm" -> FCM_TOKEN.matches(token)
        else -> false
    }
}

/** Maps the value of a successful call. */
inline fun <T, R> ApiResult<T>.map(transform: (T) -> R): ApiResult<R> = when (this) {
    is ApiResult.Ok -> ApiResult.Ok(transform(value))
    is ApiResult.Failed -> this
}
