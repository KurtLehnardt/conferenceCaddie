package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.shared.SecureStore
import app.conferencecaddie.shared.net.RequestTimeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Clock
import kotlinx.coroutines.test.runTest

// The client's error mapping (the contract's client rule), retries, time limits, pacing and the
// device credential.
class PeopleApiTest {
    private val credential = DeviceCredential.generate(BACKEND)

    private fun api(http: FakeApiHttp, pace: Pace = Pace(Clock.System), device: DeviceCredential? = credential) =
        PeopleApi(http, BACKEND, { device }, pace)

    private suspend fun errorFor(status: Int, body: String, headers: Map<String, String> = emptyMap()): PeopleError {
        val http = FakeApiHttp { FakeApiHttp.json(status, body, headers) }
        return assertIs<ApiResult.Failed>(api(http).matches(MatchesRequest(SLUG))).error
    }

    @Test
    fun everyStableCodeHasItsKind() = runTest {
        val cases = listOf(
            Triple(400, """{"error":"filtered","message":"That was held back by the filter. Edit it and try again."}""", PeopleError.Kind.Filtered),
            Triple(403, """{"error":"forbidden"}""", PeopleError.Kind.Forbidden),
            Triple(403, """{"error":"cross-origin request"}""", PeopleError.Kind.CrossOrigin),
            Triple(403, """{"error":"profile_required"}""", PeopleError.Kind.ProfileRequired),
            Triple(403, """{"error":"visibility_required"}""", PeopleError.Kind.VisibilityRequired),
            Triple(403, """{"error":"share_required","count":4}""", PeopleError.Kind.ShareRequired),
            Triple(403, """{"error":"presence_required","message":"Turn on 'Around and up for a conversation' first."}""", PeopleError.Kind.PresenceRequired),
            Triple(403, """{"error":"ble_required"}""", PeopleError.Kind.BleRequired),
            Triple(403, """{"error":"ble_rekey"}""", PeopleError.Kind.BleRekey),
            Triple(403, """{"error":"blocked"}""", PeopleError.Kind.Blocked),
            Triple(403, """{"error":"hidden"}""", PeopleError.Kind.Hidden),
            Triple(404, """{"error":"not_found"}""", PeopleError.Kind.NotFound),
            Triple(409, """{"error":"not_around","message":"They're not around right now."}""", PeopleError.Kind.NotAround),
            Triple(409, """{"error":"meet_open","meet_id":"QEFCQ0RFRkdISUpLTE1OTw"}""", PeopleError.Kind.MeetOpen),
            Triple(409, """{"error":"state","state":"active"}""", PeopleError.Kind.State),
            Triple(410, """{"error":"over","state":"expired"}""", PeopleError.Kind.Over),
            Triple(429, """{"error":"paused","message":"Three people said not now today. You can ask again tomorrow.","retry_at":"2026-11-11T06:59:59.999Z"}""", PeopleError.Kind.Paused),
            Triple(429, """{"error":"Too many requests"}""", PeopleError.Kind.RateLimited),
            Triple(503, """{"error":"daily_limit"}""", PeopleError.Kind.DailyLimit),
            Triple(502, """{"error":"People are temporarily unavailable"}""", PeopleError.Kind.Unavailable),
        )
        for ((status, body, kind) in cases) assertEquals(kind, errorFor(status, body).kind, "$status $body")
    }

    @Test
    fun theExtraKeysAreRead() = runTest {
        assertEquals(4, errorFor(403, """{"error":"share_required","count":4}""").count)
        assertEquals("QEFCQ0RFRkdISUpLTE1OTw", errorFor(409, """{"error":"meet_open","meet_id":"QEFCQ0RFRkdISUpLTE1OTw"}""").meetId)
        assertEquals(MeetState.Active, errorFor(409, """{"error":"state","state":"active"}""").state)
        assertEquals(MeetState.Expired, errorFor(410, """{"error":"over","state":"expired"}""").state)
        val paused = errorFor(429, """{"error":"paused","message":"Three people said not now today. You can ask again tomorrow.","retry_at":"2026-11-11T06:59:59.999Z"}""", mapOf("Retry-After" to "3600"))
        assertEquals("2026-11-11T06:59:59.999Z", paused.retryAt)
        assertEquals(3600L, paused.retryAfterSeconds)
        assertEquals("Three people said not now today. You can ask again tomorrow.", paused.message)
        assertEquals(30L, errorFor(429, """{"error":"Too many requests"}""", mapOf("Retry-After" to " 30 ")).retryAfterSeconds)
        assertNull(errorFor(429, """{"error":"Too many requests"}""", mapOf("Retry-After" to "Wed, 21 Oct 2026 07:28:00 GMT")).retryAfterSeconds)
    }

    @Test
    fun otherErrorsFallBackToTheirStatusClass() = runTest {
        assertEquals(PeopleError.Kind.Refused, errorFor(400, """{"error":"zone must be one of the conference's zones"}""").kind)
        assertEquals(PeopleError.Kind.NotPossible, errorFor(404, """{"error":"talk not found"}""").kind)
        assertEquals(PeopleError.Kind.NotPossible, errorFor(403, """{"error":"something new"}""").kind)
        assertEquals(PeopleError.Kind.Conflict, errorFor(409, """{"error":"something new"}""").kind)
        assertEquals(PeopleError.Kind.Gone, errorFor(410, """{"error":"something new"}""").kind)
        assertEquals(PeopleError.Kind.RateLimited, errorFor(429, "not json").kind)
        assertEquals(PeopleError.Kind.Unavailable, errorFor(500, "").kind)
        assertEquals(PeopleError.Kind.Refused, errorFor(413, """{"error":"Request body is too large"}""").kind)
        assertEquals(PeopleError.Kind.Refused, errorFor(415, """{"error":"Content-Type must be application/json"}""").kind)
        // A stable code under another status is not that code.
        assertEquals(PeopleError.Kind.Refused, errorFor(400, """{"error":"blocked"}""").kind)
    }

    @Test
    fun messagesAreTheWebs() = runTest {
        assertEquals(PeopleError.FILTERED_MESSAGE, errorFor(400, """{"error":"filtered"}""").message)
        assertEquals("Add your name to your profile first.", errorFor(400, """{"error":"display_name is required"}""").message)
        assertEquals(
            "About me is too long: 280 characters at most. Shorten it in your profile.",
            errorFor(400, """{"error":"about must be at most 280 characters"}""").message,
        )
        assertEquals(
            "A topic you picked is no longer offered. Open your profile and remove it.",
            errorFor(400, """{"error":"learn_topics contains an unknown topic: no-such"}""").message,
        )
        assertEquals("This conference has ended, so sharing is closed.", errorFor(400, """{"error":"conference has ended"}""").message)
        assertEquals(PeopleError.NOT_SAVED_MESSAGE, errorFor(400, """{"error":"Unknown key: avatar"}""").message)
        assertEquals(PeopleError.NOT_ALLOWED_MESSAGE, errorFor(403, """{"error":"forbidden"}""").message)
        assertEquals(PeopleError.TOO_MANY_MESSAGE, errorFor(429, """{"error":"Too many requests"}""").message)
        assertEquals(PeopleError.UNAVAILABLE_MESSAGE, errorFor(502, """{"error":"People are temporarily unavailable"}""").message)
        assertEquals(PeopleError.NOT_AROUND_MESSAGE, errorFor(409, """{"error":"not_around"}""").message)
        val daily = errorFor(503, """{"error":"daily_limit"}""", mapOf("Retry-After" to "60")).message
        assertTrue(daily.startsWith("People features are paused until ") && daily.endsWith(". Saved schedules still work offline."), daily)
    }

    @Test
    fun networkFailuresAndTimeouts() = runTest {
        val offline = api(FakeApiHttp { throw IllegalStateException("no route to host") }).inbox(SLUG)
        assertEquals(PeopleError.Kind.Offline, offline.errorOrNull?.kind)
        assertEquals(0, offline.errorOrNull?.status)
        assertEquals(PeopleError.OFFLINE_MESSAGE, offline.errorOrNull?.message)
        val slow = api(FakeApiHttp { throw RequestTimeout(it.timeoutMs) }).deleteProfile(SLUG)
        assertEquals(PeopleError.Kind.Timeout, slow.errorOrNull?.kind)
        assertEquals(PeopleError.TIMEOUT_MESSAGE, slow.errorOrNull?.message)
        val broken = api(FakeApiHttp { FakeApiHttp.json(200, "<html>") }).inbox(SLUG)
        assertEquals(PeopleError.Kind.BadResponse, broken.errorOrNull?.kind)
    }

    @Test
    fun writesWaitTwentySecondsAndEverythingElseThirty() = runTest {
        val http = FakeApiHttp { FakeApiHttp.json(200, """{"ok":true}""") }
        val a = api(http)
        a.deleteProfile(SLUG)
        a.deletePresence(SLUG)
        a.putProfile(ProfilePutRequest(SLUG, ProfileFields("A"), openToMeet = true))
        a.inbox(SLUG)
        assertEquals(listOf(20_000L, 20_000L, 20_000L, 30_000L), http.sent.map { it.timeoutMs })
        assertEquals(PeopleApi.WRITE_TIMEOUT_MS, 20_000L)
    }

    @Test
    fun aConcurrentChangeIsRetriedOnceWhereTheContractSaysSo() = runTest {
        var n = 0
        val http = FakeApiHttp {
            n++
            if (n == 1) FakeApiHttp.json(409, """{"error":"The profile changed at the same time; try again"}""") else FakeApiHttp.json(200, """{"ok":true,"zone":"Hallway"}""")
        }
        assertIs<ApiResult.Ok<*>>(api(http).putPresence(PresencePutRequest(SLUG, "Hallway")))
        assertEquals(2, http.sent.size)

        // At most once.
        val always = FakeApiHttp { FakeApiHttp.json(409, """{"error":"The meet changed at the same time; try again"}""") }
        assertEquals(PeopleError.Kind.Conflict, api(always).acceptMeet("QEFCQ0RFRkdISUpLTE1OTw").errorOrNull?.kind)
        assertEquals(2, always.sent.size)

        // A stable 409 is never retried, and neither is an ask.
        val open = FakeApiHttp { FakeApiHttp.json(409, """{"error":"meet_open","meet_id":"QEFCQ0RFRkdISUpLTE1OTw"}""") }
        api(open).requestMeet(MeetRequest(SLUG, "3f2a9c0d1e4b5a68"))
        assertEquals(1, open.sent.size)
        val askConflict = FakeApiHttp { FakeApiHttp.json(409, """{"error":"something"}""") }
        api(askConflict).requestMeet(MeetRequest(SLUG, "3f2a9c0d1e4b5a68"))
        assertEquals(1, askConflict.sent.size)
    }

    @Test
    fun theDeviceHeaderGoesOnlyToItsBackend() = runTest {
        val http = FakeApiHttp { FakeApiHttp.json(200, """{"refs":[],"blocks":[]}""") }
        assertEquals(PeopleError.Kind.NoDevice, api(http, device = null).blocks(SLUG).errorOrNull?.kind)
        val other = BackendUrl.normalise("https://caddie.example/other") as BackendUrl.Valid
        val foreign = DeviceCredential.generate(other)
        assertEquals(PeopleError.Kind.NoDevice, api(http, device = foreign).blocks(SLUG).errorOrNull?.kind)
        assertTrue(http.sent.isEmpty(), "nothing was sent without this backend's credential")
        api(http).blocks(SLUG)
        assertEquals(credential.header(), http.sent.single().headers[PeopleApi.DEVICE_HEADER])
        // Public routes never carry it.
        api(http).circleCounts(CircleCountsRequest(SLUG))
        api(http).vapidKey()
        assertNull(http.sent[1].headers[PeopleApi.DEVICE_HEADER])
        assertNull(http.sent[2].headers[PeopleApi.DEVICE_HEADER])
    }

    @Test
    fun theEventGoesInTheQueryOnlyForRoutesWithoutABody() = runTest {
        val http = FakeApiHttp { FakeApiHttp.json(200, "{}") }
        val a = api(http)
        a.inbox("a-b")
        a.deleteProfile("a-b")
        a.readMeet("QEFC/../x")
        assertEquals("https://caddie.example/api/meet/inbox?event=a-b", http.sent[0].url)
        assertEquals("https://caddie.example/api/people/profile?event=a-b", http.sent[1].url)
        assertEquals("https://caddie.example/api/meet/QEFC%2F..%2Fx", http.sent[2].url, "a meet id never leaves its path segment")
    }

    @Test
    fun thePaceStretchesPollsAndDecays() = runTest {
        var nowMs = 0L
        val clock = object : Clock {
            override fun now() = kotlin.time.Instant.fromEpochMilliseconds(nowMs)
        }
        val pace = Pace(clock)
        val http = FakeApiHttp { FakeApiHttp.json(200, "{}", mapOf("X-Caddie-Pace" to "4")) }
        api(http, pace).inbox(SLUG)
        assertEquals(4.0, pace.current())
        assertEquals(180_000L, pace.pacedMs(45_000))
        assertEquals(45_000L, pace.pacedMeetMs(15_000), "a meet poll stretches at most three times")
        pace.note("25")
        assertEquals(10.0, pace.current(), "clamped to 10")
        pace.note("nonsense")
        assertEquals(10.0, pace.current())
        nowMs += Pace.DECAY_MS + 1
        assertEquals(1.0, pace.current(), "decays after 30 minutes without news")
    }

    @Test
    fun credentialsHaveTheContractsFormatAndStayWithTheirBackend() = runTest {
        val store = InMemorySecureStore()
        val a = DeviceCredentials(store, BACKEND)
        assertNull(a.get())
        val first = a.ensure()
        val header = first.header()
        assertTrue(Regex("^[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}$").matches(header), "22 and 43 base64url characters")
        assertEquals(first, a.ensure(), "generated once")
        assertEquals(first, DeviceCredentials(store, BACKEND).get(), "read back from the secure store")
        assertEquals(header, store.get(SecureStore.scopedKey(BACKEND, DeviceCredential.STORE_NAME)))

        // Another backend on the same origin gets its own.
        val sibling = BackendUrl.normalise("https://caddie.example/tier1") as BackendUrl.Valid
        val b = DeviceCredentials(store, sibling).ensure()
        assertNotEquals(first.header(), b.header())
        assertEquals(sibling.base, b.backendBase)

        // Never printed.
        assertFalse(first.toString().contains(header.substringBefore('.')))
        assertFalse(first.toString().contains(header.substringAfter('.')))

        a.forget()
        assertNull(a.get())
        assertNull(store.get(SecureStore.scopedKey(BACKEND, DeviceCredential.STORE_NAME)))
        assertNotNull(DeviceCredentials(store, sibling).get(), "forgetting one backend's leaves the other's")

        // A malformed stored value reads as none.
        store.put(SecureStore.scopedKey(BACKEND, DeviceCredential.STORE_NAME), "short.value")
        assertNull(DeviceCredentials(store, BACKEND).get())
    }

    @Test
    fun randomValuesDiffer() {
        val headers = (1..50).map { DeviceCredential.generate(BACKEND).header() }.toSet()
        assertEquals(50, headers.size)
    }

    @Test
    fun nativePushTokensAreCheckedBeforeTheyAreSent() {
        assertTrue(NativePush.validToken("apns", "ab".repeat(32)))
        assertFalse(NativePush.validToken("apns", "abc"))
        assertFalse(NativePush.validToken("apns", "a".repeat(65)), "an odd count of hex digits")
        assertTrue(NativePush.validToken("fcm", "dQw4w9WgXcQ:APA91b" + "x".repeat(40)))
        assertFalse(NativePush.validToken("fcm", "short"))
        assertFalse(NativePush.validToken("webpush", "ab".repeat(32)))
    }
}
