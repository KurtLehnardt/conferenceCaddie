package app.conferencecaddie.shared.ble

import app.conferencecaddie.shared.people.ConnectRuntime
import app.conferencecaddie.shared.people.FakeApiHttp
import app.conferencecaddie.shared.people.FakeNotifier
import app.conferencecaddie.shared.people.NearbyPerson
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.shared.people.PresenceMode
import app.conferencecaddie.shared.people.BleProblem
import app.conferencecaddie.shared.people.BleOutcome
import app.conferencecaddie.shared.people.TopicRef
import app.conferencecaddie.shared.people.page
import app.conferencecaddie.shared.people.person
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

// Re-keying (docs/contracts/ble-tokens.md, Re-keying) and the nearby notifications (web ble.ts).
class BleRekeyNotifyTest {
    private fun repeated(slug: String) = """{"event":"$slug","zone":"Hallway","spot":"Green jacket","ble":true}"""

    @Test
    fun anAnswerNamingAnotherKeyReKeysWithAWriteThatRepeatsPresence() = runTest {
        val b = BleRig(this)
        b.on()
        val oldPayload = b.radio.source!!.payloadNow()!!
        var other = true
        b.h.server.sightings = { if (other) b.answer(keyId = "AAAAAAAAAAA").also { other = false } else b.answer() }
        b.h.http.sent.clear()
        b.radio.hear(otherPayload(1), -60, b.now())
        runCurrent()
        assertEquals(repeated(b.slug), b.presencePuts().single().body)
        assertEquals(2, b.h.server.bleKeys.size)
        assertEquals(b.h.server.bleKeyId(), BleProtocol.keyIdOf(b.keys.hmac(b.alias, BleProtocol.keyIdMessage())!!), "the new key under the same alias")
        assertEquals(setOf(b.alias), b.keys.aliases)
        assertEquals(1, b.radio.refreshes, "the radio serves the new key's payload at once")
        assertFalse(oldPayload.contentEquals(b.radio.source!!.payloadNow()!!))
        assertTrue(b.view.on)
        assertTrue(b.h.state.presence.on)
        // The next report names the new key: nothing more.
        b.radio.hear(otherPayload(2), -60, b.now())
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(2, b.sightings().size)
        assertEquals(1, b.presencePuts().size)
    }

    @Test
    fun anAnswerWithoutAKeyIdOrBleRekeyReKeysToo() = runTest {
        val b = BleRig(this)
        b.on()
        var answers = listOf(b.answer(keyId = null))
        b.h.server.sightings = { answers.firstOrNull()?.also { answers = answers.drop(1) } ?: b.answer() }
        b.radio.hear(otherPayload(1), -60, b.now())
        runCurrent()
        assertEquals(1, b.presencePuts().size, "no ble_key_id: a session the backend does not resolve as derived-v1")

        // Ten minutes on, a new window: a retired master asks for a new key, and the sightings wait.
        advanceTimeBy(600_000)
        runCurrent()
        answers = listOf(FakeApiHttp.json(403, """{"error":"ble_rekey"}"""))
        b.radio.hear(otherPayload(2), -60, b.now())
        runCurrent()
        assertEquals(2, b.presencePuts().size)
        assertTrue(b.view.on)
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(listOf(tokenText(2) to -60), b.reported(b.sightings().last()), "reported again under the new key")
        assertEquals(3, b.h.server.bleKeys.size)
    }

    @Test
    fun aSecondReKeyInOneWindowStopsHereWithoutTellingTheServer() = runTest {
        val b = BleRig(this)
        b.on()
        // Another device with this profile keeps taking the key.
        b.h.server.sightings = { b.answer(keyId = "AAAAAAAAAAA") }
        b.radio.hear(otherPayload(1), -60, b.now())
        runCurrent()
        assertEquals(1, b.presencePuts().size)
        b.radio.hear(otherPayload(2), -60, b.now())
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(1, b.presencePuts().size, "no second re-key, and no ble: false")
        assertFalse(b.radio.running)
        assertTrue(b.keys.aliases.isEmpty())
        assertFalse(b.view.on)
        assertEquals(BleProblem.OtherDevice, b.view.problem)
        assertEquals(PeopleText.BLE_OTHER_DEVICE, b.view.message)
        assertTrue(b.h.state.presence.on, "presence stays")
        assertEquals(0, b.h.sent("DELETE", "/api/presence").size)
    }

    @Test
    fun bleRequiredStopsWithoutARequest() = runTest {
        val b = BleRig(this)
        b.on()
        b.h.server.sightings = { FakeApiHttp.json(403, """{"error":"ble_required"}""") }
        b.radio.hear(otherPayload(1), -60, b.now())
        runCurrent()
        assertFalse(b.radio.running)
        assertTrue(b.keys.aliases.isEmpty())
        assertFalse(b.view.on)
        assertNull(b.view.problem)
        assertTrue(b.presencePuts().isEmpty())
        // A late event of the stopped radio changes nothing.
        b.radio.hear(otherPayload(2), -60, b.now())
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(1, b.sightings().size)
    }

    @Test
    fun aFailedReKeyKeepsRunningAndIsTriedAgainAtTheNextReport() = runTest {
        val b = BleRig(this)
        b.on()
        val put = b.h.server.presencePut
        var fail = true
        b.h.server.presencePut = { r -> if (fail) FakeApiHttp.json(503, """{"error":"People are temporarily unavailable"}""").also { fail = false } else put(r) }
        var other = true
        b.h.server.sightings = { if (other) b.answer(keyId = "AAAAAAAAAAA").also { other = false } else b.answer() }
        b.radio.hear(otherPayload(1), -60, b.now())
        runCurrent()
        assertEquals(1, b.presencePuts().size)
        assertTrue(b.view.on)
        assertEquals(1, b.h.server.bleKeys.size)
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(2, b.presencePuts().size, "tried again at the next report, even with nothing heard")
        assertEquals(2, b.h.server.bleKeys.size)
        assertEquals(b.h.server.bleKeyId(), BleProtocol.keyIdOf(b.keys.hmac(b.alias, BleProtocol.keyIdMessage())!!))
        assertTrue(b.view.on)
    }

    @Test
    fun aReKeyThatKeepsFailingBacksOffInsteadOfRetryingAtOnce() = runTest {
        val b = BleRig(this)
        b.on()
        val put = b.h.server.presencePut
        // Offline for the re-key writes, with nothing else heard: the retries wait 10, 20, 40 and
        // 80 seconds (doubling from the interval), not one write after another.
        b.h.server.presencePut = { FakeApiHttp.json(503, """{"error":"People are temporarily unavailable"}""") }
        b.h.server.sightings = { b.answer(keyId = "AAAAAAAAAAA") }
        b.radio.hear(otherPayload(1), -60, b.now())
        runCurrent()
        assertEquals(1, b.presencePuts().size)
        advanceTimeBy(9_000)
        runCurrent()
        assertEquals(1, b.presencePuts().size, "no retry before the interval")
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(2, b.presencePuts().size)
        advanceTimeBy(150_000)
        runCurrent()
        // Retries at 10, 30, 70 and 150 seconds after the first failure.
        assertEquals(5, b.presencePuts().size)
        assertTrue(b.view.on, "a failed re-key keeps running")

        // Back online: the next re-key goes through and clears the wait, so a report that then
        // fails once is tried again after the interval, not after the doubled wait.
        b.h.server.presencePut = put
        b.h.server.sightings = { FakeApiHttp.json(503, """{"error":"People are temporarily unavailable"}""") }
        advanceTimeBy(160_000)
        runCurrent()
        assertEquals(6, b.presencePuts().size)
        val reports = b.sightings().size
        b.radio.hear(otherPayload(2), -60, b.now())
        runCurrent()
        assertEquals(reports + 1, b.sightings().size, "the report goes at once, and fails")
        advanceTimeBy(9_999)
        runCurrent()
        assertEquals(reports + 1, b.sightings().size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(reports + 2, b.sightings().size, "tried again after the interval, not after the re-key's doubled wait")
    }

    // ---------------------------------------------------------------------------------------------
    // Notifications

    private fun FakeNotifier.ble() = shown.filter { it.id.startsWith("caddie-ble-") }

    @Test
    fun theFirstStrongMatchBecomesOneNotificationThatLandsOnTheirCard() = runTest {
        val b = BleRig(this)
        b.on()
        b.h.server.sightings = { b.answer(nearby("r1", evidence = "<mark>eBPF</mark> tracing at scale &amp; more."), nearby("r2", evidence = "Kubernetes")) }
        b.radio.hear(otherPayload(1), -60, b.now())
        runCurrent()
        assertEquals(
            listOf(FakeNotifier.Shown("caddie-ble-${b.slug}", "Conference Caddie", "Someone who's worked on eBPF tracing at scale & more is right near you", "caddie://people?around=1")),
            b.h.notifier.shown,
        )
        assertEquals(ConnectRuntime.NOTIFICATION_TITLE, b.h.notifier.shown.single().title)
        assertEquals("r1", b.h.state.reveal, "a tap lands on their card")

        // r1 was told about today; r2 is next.
        b.radio.hear(otherPayload(2), -60, b.now())
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(2, b.h.notifier.ble().size)
        assertEquals("Someone who's worked on Kubernetes is right near you", b.h.notifier.ble().last().body)
        b.radio.hear(otherPayload(3), -60, b.now())
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(2, b.h.notifier.ble().size, "once per person per day")
    }

    @Test
    fun inAppNudgesAndBluetoothNeverRepeatEachOther() = runTest {
        val b = BleRig(this)
        b.on()
        b.h.server.sightings = { b.answer(nearby("r1", evidence = "Rust")) }
        b.radio.hear(otherPayload(1), -60, b.now())
        runCurrent()
        assertEquals(1, b.h.notifier.ble().size)
        // The in-app check finds r1 too: already told today.
        b.h.server.matches = { page(person("r1", zone = "Hallway", evidence = "Rust")) }
        b.controller.backgroundCheck()
        assertNull(b.h.state.nudge)
        // r3 is nudged in the app first; Bluetooth then leaves r3 out.
        b.h.server.matches = { page(person("r3", zone = "Hallway", evidence = "Go")) }
        b.controller.backgroundCheck()
        assertEquals("r3", b.h.state.nudge?.ref)
        b.h.server.sightings = { b.answer(nearby("r3", evidence = "Go")) }
        b.radio.hear(otherPayload(2), -60, b.now())
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(1, b.h.notifier.ble().size)
    }

    @Test
    fun atMostThreeInARollingHourAndNeverABlockedPerson() = runTest {
        val b = BleRig(this)
        b.h.start(BLE_ON)
        b.h.visible()
        b.controller.turnOnPresence("Hallway", "", PresenceMode.Day)
        assertEquals(BleOutcome.On, b.controller.turnOnBluetooth())
        b.h.server.other = { FakeApiHttp.json(200, """{"ok":true}""") }
        assertNull(b.controller.block("r0", "Blocked Person"))
        var n = 0
        b.h.server.sightings = { n++; b.answer(nearby("r0", evidence = "Spam"), nearby("r$n", evidence = "Topic $n")) }
        for (i in 1..4) {
            b.radio.hear(otherPayload(i), -60, b.now())
            advanceTimeBy(10_000)
            runCurrent()
        }
        assertEquals(4, b.sightings().size)
        assertEquals(listOf("r1", "r2", "r3").map { "Someone who's worked on Topic ${it.drop(1)} is right near you" }, b.h.notifier.ble().map { it.body })
        // An hour after the first, there is room for one more.
        advanceTimeBy(3_600_000 - 40_000)
        runCurrent()
        b.radio.hear(otherPayload(9), -60, b.now())
        runCurrent()
        assertEquals(4, b.h.notifier.ble().size)
        assertEquals("Someone who's worked on Topic 5 is right near you", b.h.notifier.ble().last().body)
    }

    @Test
    fun withoutEvidenceTheFirstSpeakTopicAndWithNeitherTheNextPerson() = runTest {
        val b = BleRig(this)
        b.on()
        b.h.server.sightings = { b.answer(nearby("r1", evidence = null, speak = null), nearby("r2", evidence = null, speak = "eBPF")) }
        b.radio.hear(otherPayload(1), -60, b.now())
        runCurrent()
        assertEquals(listOf("Someone who's worked on eBPF is right near you"), b.h.notifier.ble().map { it.body })
        assertEquals("r2", b.h.state.reveal)
    }

    @Test
    fun evidenceWordsFollowTheWeb() {
        fun ev(evidence: String?, speak: String? = null) =
            PeopleText.nearbyEvidence(NearbyPerson("r", "N", evidence, listOfNotNull(speak?.let { TopicRef("t", it) })))
        assertEquals("eBPF & XDP at 'scale' <now>", ev("<mark>eBPF</mark>  &amp;\n XDP at &#39;scale&apos; &lt;now&gt;;:"))
        assertEquals("Built a distributed tracing pipeline for Kubernetes clusters that handles…", ev("Built a distributed tracing pipeline for Kubernetes clusters that handles millions of spans every second."))
        assertEquals("x".repeat(81) + "…", ev("x".repeat(120)), "no word boundary: the web keeps the 81 characters it looked at")
        assertEquals("y".repeat(80), ev("y".repeat(80) + "."))
        assertEquals("Rust", ev("", "Rust"))
        assertEquals("Rust", ev(null, "Rust"))
        assertNull(ev(null))
        assertEquals("Someone who's worked on x is right near you", PeopleText.nearbyText("x"))
    }
}
