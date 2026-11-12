package app.conferencecaddie.shared.ble

import app.conferencecaddie.shared.fixtures.Fixtures
import app.conferencecaddie.shared.people.FakeApiHttp
import app.conferencecaddie.shared.people.PresenceMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// The payload this phone serves, and the sightings it reports (docs/contracts/ble-tokens.md, Over
// the air): the interval, the first-heard deadline, the five-minute age, the 50 strongest, the RSSI
// threshold, this phone's own tokens and the tokens already reported in the window, and backoff.
class BleSightingsTest {
    private fun ByteArray.hex(): String = joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    private fun hex(text: String): ByteArray = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test
    fun thePayloadIsTheGoldenVectorOfTheClocksWindowAndChangesAtEachBoundary() = runTest {
        val golden = Fixtures.json("ble/golden-vectors.v1.json").jsonObject
        val keyA = hex(golden["keys"]!!.jsonObject["key-a"]!!.jsonObject["hex"]!!.jsonPrimitive.content)
        fun payload(w: String) = golden["tokens"]!!.jsonArray.map { it.jsonObject }
            .first { it["key"]!!.jsonPrimitive.content == "key-a" && it["w"]!!.jsonPrimitive.content == w }["payload_hex"]!!.jsonPrimitive.content

        // 2026-11-10T12:00:30Z: window 2990520, thirty seconds in.
        val b = BleRig(this, startMs = 1_794_312_030_000L)
        b.h.server.nextBleKey = { keyA.copyOf() }
        b.on()
        val source = b.radio.source!!
        assertEquals(payload("2990520"), source.payloadNow()!!.hex())
        assertEquals(0, b.radio.refreshes)

        advanceTimeBy(569_999)
        runCurrent()
        assertEquals(0, b.radio.refreshes)
        assertEquals(payload("2990520"), source.payloadNow()!!.hex())
        advanceTimeBy(1)
        runCurrent()
        assertEquals(1, b.radio.refreshes, "told at the window's start")
        assertEquals(payload("2990521"), source.payloadNow()!!.hex())
        advanceTimeBy(600_000)
        runCurrent()
        assertEquals(2, b.radio.refreshes)
    }

    @Test
    fun thisPhonesOwnPayloadIsNeverReported() = runTest {
        val b = BleRig(this)
        b.on()
        val w = BleProtocol.windowAtMillis(b.now())
        b.radio.hear(b.radio.source!!.payloadNow()!!, -40, b.now())
        // The windows either side, which the server also accepts, in both formats.
        b.radio.hear(BleProtocol.encodePayload(b.ownToken(w + 1)), -40, b.now())
        b.radio.hear(BleProtocol.encodePayload(b.ownToken(w - 1)), -40, b.now())
        b.radio.hear(b.ownToken(w - 1), -40, b.now())
        b.radio.hear(b.ownToken(w + 1), -40, b.now())
        advanceTimeBy(60_000)
        runCurrent()
        assertTrue(b.sightings().isEmpty())
    }

    @Test
    fun reportsWaitForTheIntervalAndSkipTokensAlreadyReportedInTheWindow() = runTest {
        val b = BleRig(this)
        b.on()
        b.radio.hear(otherPayload(1), -60, b.now())
        runCurrent()
        assertEquals(listOf(listOf(tokenText(1) to -60)), b.sightings().map { b.reported(it) }, "the first report goes at once")
        assertEquals("""{"event":"${b.slug}","sightings":[{"token":"${tokenText(1)}","rssi":-60}]}""", b.sightings().single().body)

        b.radio.hear(otherPayload(2), -70, b.now())
        b.radio.hear(otherPayload(2), -65, b.now())
        // Reported in this window already: left out, however strong.
        b.radio.hear(otherPayload(1), -40, b.now())
        advanceTimeBy(9_999)
        runCurrent()
        assertEquals(1, b.sightings().size, "one report per ten seconds")
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf(tokenText(2) to -65), b.reported(b.sightings()[1]), "the strongest RSSI of a token")

        b.radio.hear(otherPayload(1), -50, b.now())
        b.radio.hear(otherPayload(2), -50, b.now())
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(2, b.sightings().size)
        // The next window: the same tokens are reported again.
        advanceTimeBy(600_000 - 70_000)
        runCurrent()
        b.radio.hear(otherPayload(1), -50, b.now())
        runCurrent()
        assertEquals(listOf(tokenText(1) to -50), b.reported(b.sightings()[2]))
    }

    @Test
    fun theThresholdTheFormatsAndTheLegacyPayload() = runTest {
        val b = BleRig(this)
        b.on()
        b.radio.hear(otherPayload(3), -76, b.now())
        b.radio.hear(otherPayload(6), 127, b.now())
        b.radio.hear(ByteArray(18) { 1 }, -40, b.now())
        b.radio.hear(byteArrayOf(0x02) + otherToken(4), -40, b.now())
        advanceTimeBy(30_000)
        runCurrent()
        assertTrue(b.sightings().isEmpty(), "weaker than near_rssi, no reading at all, or a format this app does not know")
        b.radio.hear(otherPayload(3), -75, b.now())
        b.radio.hear(otherToken(5), -55, b.now())
        runCurrent()
        assertEquals(setOf(tokenText(3) to -75, tokenText(5) to -55), b.reported(b.sightings().single()).toSet(), "a bare 16-byte legacy token is reported the same way")
    }

    @Test
    fun aLongIntervalIsHonouredFromTheFirstSightingAndOldSightingsAreDropped() = runTest {
        val b = BleRig(this)
        b.on(bleCaps(300))
        val t0 = b.now()
        b.radio.hear(otherPayload(1), -60, t0)
        runCurrent()
        assertEquals(1, b.sightings().size)

        advanceTimeBy(5_000)
        b.radio.hear(otherPayload(2), -60, b.now())
        advanceTimeBy(294_999)
        runCurrent()
        assertEquals(1, b.sightings().size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf(tokenText(2) to -60), b.reported(b.sightings()[1]), "no later than the interval after the first sighting")

        // Heard 250 seconds before the radio passed it on: by the next report it is too old.
        advanceTimeBy(1_000)
        b.radio.hear(otherPayload(3), -60, b.now() - 250_000)
        // Older than five minutes already: dropped at once.
        b.radio.hear(otherPayload(4), -60, b.now() - 301_000)
        advanceTimeBy(600_000)
        runCurrent()
        assertEquals(2, b.sightings().size)
    }

    @Test
    fun aTokenHeardAllAlongIsStillReportedAfterReportsFailedForMoreThanFiveMinutes() = runTest {
        val b = BleRig(this)
        b.on(bleCaps(300))
        val t0 = b.now()
        val at = ArrayList<Long>()
        var failures = 2
        b.h.server.sightings = {
            at += b.now() - t0
            if (failures-- > 0) FakeApiHttp.json(503, """{"error":"People are temporarily unavailable"}""") else b.answer()
        }
        // The same phone, heard every ten seconds for ten minutes (the last time at 590 seconds).
        for (i in 0 until 60) {
            b.radio.hear(otherPayload(1), -60, b.now())
            advanceTimeBy(10_000)
            runCurrent()
        }
        // First heard at 0, failed at 0 and at 300 seconds: still heard ten seconds ago, so not too old.
        assertEquals(listOf(0L, 300_000, 600_000), at)
        assertEquals(listOf(tokenText(1) to -60), b.reported(b.sightings().last()))
    }

    @Test
    fun aReportHoldsTheFiftyStrongestAndTheRestFollow() = runTest {
        val b = BleRig(this)
        b.on(bleCaps(10, nearRssi = -100))
        for (i in 0 until 60) b.radio.hear(otherPayload(100 + i), -30 - i, b.now())
        runCurrent()
        val first = b.reported(b.sightings().single())
        assertEquals(50, first.size)
        assertEquals((0 until 50).map { tokenText(100 + it) to -30 - it }, first)
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals((50 until 60).map { tokenText(100 + it) to -30 - it }, b.reported(b.sightings()[1]))
    }

    @Test
    fun serverErrorsBackOffFromTheIntervalDoublingUpToFiveMinutes() = runTest {
        val b = BleRig(this)
        b.on()
        val at = ArrayList<Long>()
        val t0 = b.now()
        b.h.server.sightings = {
            at += b.now() - t0
            FakeApiHttp.json(503, """{"error":"People are temporarily unavailable"}""")
        }
        // A fresh token every five seconds, so something is always waiting to be reported.
        for (i in 0 until 200) {
            b.radio.hear(otherPayload(i), -60, b.now())
            advanceTimeBy(5_000)
            runCurrent()
        }
        assertEquals(listOf(0L, 10_000, 30_000, 70_000, 150_000, 310_000, 610_000, 910_000), at)
    }

    @Test
    fun aServerThatKeepsRefusingIsAskedLessAndLessAndItsBatchesAreDropped() = runTest {
        val b = BleRig(this)
        b.on()
        val at = ArrayList<Long>()
        val t0 = b.now()
        b.h.server.sightings = {
            at += b.now() - t0
            FakeApiHttp.json(404, """{"error":"Not found"}""")
        }
        for (i in 0 until 200) {
            b.radio.hear(otherPayload(i), -60, b.now())
            advanceTimeBy(5_000)
            runCurrent()
        }
        assertEquals(listOf(0L, 10_000, 30_000, 70_000, 150_000, 310_000, 610_000, 910_000), at, "the same wait as a server error")
        assertEquals(listOf(tokenText(0) to -60), b.reported(b.sightings()[0]))
        assertTrue(tokenText(0) !in b.reported(b.sightings()[1]).map { it.first }, "a refused batch is not sent again")
    }

    @Test
    fun aNetworkFailureBacksOffTooAndKeepsTheSightings() = runTest {
        val b = BleRig(this)
        b.on()
        val t0 = b.now()
        val at = ArrayList<Long>()
        var failing = true
        b.h.server.sightings = {
            at += b.now() - t0
            if (failing) throw IllegalStateException("offline")
            b.answer()
        }
        b.radio.hear(otherPayload(1), -60, b.now())
        runCurrent()
        advanceTimeBy(1_000)
        b.radio.hear(otherPayload(2), -50, b.now())
        advanceTimeBy(9_000)
        runCurrent()
        advanceTimeBy(20_000)
        runCurrent()
        assertEquals(listOf(0L, 10_000, 30_000), at)
        failing = false
        advanceTimeBy(40_000)
        runCurrent()
        assertEquals(listOf(0L, 10_000, 30_000, 70_000), at)
        assertEquals(listOf(tokenText(2) to -50, tokenText(1) to -60), b.reported(b.sightings().last()), "kept through the failures")
        // Back to the interval once it works.
        b.radio.hear(otherPayload(3), -50, b.now())
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(80_000, at.last())
    }

    @Test
    fun tooManyRequestsWaitsForRetryAfterOrThePace() = runTest {
        val b = BleRig(this)
        b.on()
        val t0 = b.now()
        val at = ArrayList<Long>()
        var answers = listOf(
            FakeApiHttp.json(429, """{"error":"Too many requests"}""", mapOf("Retry-After" to "45")),
            FakeApiHttp.json(429, """{"error":"Too many requests"}""", mapOf("X-Caddie-Pace" to "3")),
        )
        b.h.server.sightings = {
            at += b.now() - t0
            answers.firstOrNull()?.also { answers = answers.drop(1) } ?: b.answer()
        }
        b.radio.hear(otherPayload(1), -60, b.now())
        runCurrent()
        advanceTimeBy(1_000)
        b.radio.hear(otherPayload(2), -60, b.now())
        advanceTimeBy(44_000)
        runCurrent()
        assertEquals(listOf(0L, 45_000), at, "Retry-After, not the interval")
        // Without Retry-After: the interval stretched by the pace the answer reported.
        advanceTimeBy(29_999)
        runCurrent()
        assertEquals(2, at.size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf(0L, 45_000, 75_000), at)
        assertEquals(2, b.reported(b.sightings().last()).size)
    }

    @Test
    fun retryAfterIsFollowedForAtLeastTheIntervalAndAtMostAnHour() = runTest {
        val b = BleRig(this)
        // The day, so presence outlasts the hour.
        b.on(mode = PresenceMode.Day)
        val t0 = b.now()
        val at = ArrayList<Long>()
        var answers = listOf(
            FakeApiHttp.json(429, """{"error":"Too many requests"}""", mapOf("Retry-After" to "0")),
            FakeApiHttp.json(429, """{"error":"Too many requests"}""", mapOf("Retry-After" to "999999")),
        )
        b.h.server.sightings = {
            at += b.now() - t0
            answers.firstOrNull()?.also { answers = answers.drop(1) } ?: b.answer()
        }
        b.radio.hear(otherPayload(1), -60, b.now())
        runCurrent()
        advanceTimeBy(9_999)
        runCurrent()
        assertEquals(listOf(0L), at, "Retry-After 0 still waits the interval")
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf(0L, 10_000), at)
        // Retry-After of eleven days: an hour at most. Something heard just before then is reported then.
        advanceTimeBy(3_595_000)
        runCurrent()
        b.radio.hear(otherPayload(2), -60, b.now())
        advanceTimeBy(4_999)
        runCurrent()
        assertEquals(2, at.size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf(0L, 10_000, 3_610_000), at)
        assertEquals(listOf(tokenText(2) to -60), b.reported(b.sightings().last()))
    }

    @Test
    fun theRadioIsAskedToKeepTheAppAwakeUntilTheNextReport() = runTest {
        val b = BleRig(this)
        b.on()
        val t0 = b.now()
        b.radio.hear(otherPayload(1), -60, t0)
        runCurrent()
        assertEquals(listOf(t0), b.radio.keepAwake, "the first report goes at once")
        assertEquals(1, b.sightings().size)
        b.radio.hear(otherPayload(2), -60, b.now())
        b.radio.hear(otherPayload(3), -60, b.now())
        runCurrent()
        assertEquals(listOf(t0, t0 + 10_000), b.radio.keepAwake, "the next one an interval later, asked for once")
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(2, b.sightings().size)
        assertEquals(2, b.radio.keepAwake.size, "nothing waits, so nothing to stay awake for")
    }

    @Test
    fun aClockBefore1970ServesNothingInsteadOfThrowing() = runTest {
        val keys = InMemoryBleKeyStore()
        keys.put("a", ByteArray(32) { 1 })
        var nowMs = -1L
        val clock = object : Clock {
            override fun now(): Instant = Instant.fromEpochMilliseconds(nowMs)
        }
        val source = BleRuntime.Source(keys, "a", clock)
        assertNull(source.payloadNow())
        nowMs = 0
        assertNotNull(source.payloadNow())
    }

    @Test
    fun aRefusedBatchIsDroppedWhileAFailedOneIsKept() = runTest {
        val b = BleRig(this)
        b.on()
        var answers = listOf(
            FakeApiHttp.json(400, """{"error":"sightings must be an array"}"""),
            FakeApiHttp.json(502, """{"error":"People are temporarily unavailable"}"""),
        )
        b.h.server.sightings = { answers.firstOrNull()?.also { answers = answers.drop(1) } ?: b.answer() }
        b.radio.hear(otherPayload(1), -60, b.now())
        runCurrent()
        b.radio.hear(otherPayload(2), -60, b.now())
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(listOf(tokenText(2) to -60), b.reported(b.sightings()[1]), "the refused batch is not sent again")
        b.radio.hear(otherPayload(3), -55, b.now())
        // The refusal started the backoff, so the wait after the 502 is twice the interval.
        advanceTimeBy(19_999)
        runCurrent()
        assertEquals(2, b.sightings().size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf(tokenText(3) to -55, tokenText(2) to -60), b.reported(b.sightings()[2]), "the failed one is")
    }
}
