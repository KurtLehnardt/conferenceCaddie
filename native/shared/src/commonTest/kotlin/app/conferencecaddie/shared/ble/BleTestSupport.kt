package app.conferencecaddie.shared.ble

import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.net.HttpResponse
import app.conferencecaddie.shared.people.BACKEND
import app.conferencecaddie.shared.people.BleOutcome
import app.conferencecaddie.shared.people.BleView
import app.conferencecaddie.shared.people.FIXTURE_SLUG
import app.conferencecaddie.shared.people.FakeApiHttp
import app.conferencecaddie.shared.people.PEOPLE_ON
import app.conferencecaddie.shared.people.PeopleHarness
import app.conferencecaddie.shared.people.START_MS
import app.conferencecaddie.shared.people.SentRequest
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int

/** A radio that records what it is told and lets a test hear payloads and stop it. */
class FakeBleRadio(
    override var supported: Boolean = true,
    override var permissionKind: BlePermissionKind = BlePermissionKind.NearbyDevices,
) : BleRadio {
    var accessNow = BleAccess.Granted
    var afterRequest = BleAccess.Granted
    var stateNow = BleRadioState.Ready
    var log: MutableList<String>? = null
    var requests = 0
    var refreshes = 0
    var stops = 0
    val starts = ArrayList<BleRadioConfig>()
    var source: BlePayloadSource? = null
    var events: BleRadioEvents? = null
    override var running = false

    override fun access(): BleAccess {
        log?.add("access")
        return accessNow
    }

    /** Runs while the system prompt would show. */
    var duringRequest: () -> Unit = {}

    /** How long the system prompt stays up, in virtual milliseconds. */
    var promptMs = 0L

    override suspend fun requestAccess(): BleAccess {
        log?.add("requestAccess")
        requests++
        duringRequest()
        if (promptMs > 0) delay(promptMs)
        accessNow = afterRequest
        return accessNow
    }

    override fun state(): BleRadioState {
        log?.add("state")
        return stateNow
    }

    override fun start(config: BleRadioConfig, source: BlePayloadSource, events: BleRadioEvents) {
        log?.add("start")
        starts += config
        this.source = source
        this.events = events
        running = true
    }

    override fun refresh() {
        log?.add("refresh")
        refreshes++
    }

    override fun stop() {
        log?.add("stop")
        stops++
        running = false
    }

    /** Another phone's payload heard at [rssi] dBm at [at]. */
    fun hear(payload: ByteArray, rssi: Int, at: Long) = events!!.onHeard(payload, rssi, at)

    /** The radio stopped by itself. */
    fun stopBySelf(reason: BleStopReason) {
        running = false
        events!!.onStopped(reason)
    }
}

/** An [InMemoryBleKeyStore] that also writes its calls (never the key) to a log. */
class RecordingKeyStore : BleKeyStore {
    val inner = InMemoryBleKeyStore()
    var log: MutableList<String>? = null
    val aliases: Set<String> get() = inner.aliases

    /** Makes the platform store fail, as a Keystore or Keychain error would. */
    var failPut = false
    var failHmac = false

    /** The last key handed to [put], to check the caller zeroed its own copy. */
    var lastPutArgument: ByteArray? = null

    override suspend fun put(alias: String, key: ByteArray) {
        log?.add("keys.put")
        lastPutArgument = key
        if (failPut) throw IllegalStateException("key store unavailable")
        inner.put(alias, key)
    }

    override fun hmac(alias: String, message: ByteArray): ByteArray? {
        if (failHmac) throw IllegalStateException("key store unavailable")
        return inner.hmac(alias, message)
    }

    override suspend fun remove(alias: String) {
        log?.add("keys.remove")
        inner.remove(alias)
    }
}

/** Every people feature on with derived-v1 Bluetooth, a 10-second interval and -75 dBm. */
val BLE_ON: Capabilities = PEOPLE_ON.copy(
    ble = Capabilities.Ble(mode = Capabilities.BleMode.DerivedV1, nearRssi = -75, sightingsMinIntervalSeconds = 10),
)

/** BLE_ON with another sightings interval. */
fun bleCaps(intervalSeconds: Int, nearRssi: Int = -75): Capabilities =
    BLE_ON.copy(ble = BLE_ON.ble.copy(sightingsMinIntervalSeconds = intervalSeconds, nearRssi = nearRssi))

/**
 * A people controller with a fake radio and an in-memory key store on virtual time, over
 * [app.conferencecaddie.shared.people.StubPeopleServer]: presence writes with `ble: true` hand out
 * a fresh key, and sightings answer `{ nearby: [], ble_key_id }` with the key handed out last.
 */
class BleRig(val test: TestScope, startMs: Long = START_MS) {
    val radio = FakeBleRadio()
    val keys = RecordingKeyStore()
    val h = PeopleHarness(test, ble = BlePlatform(radio, keys), startMs = startMs)
    val log = ArrayList<String>()
    val slug = FIXTURE_SLUG
    val alias = BleProtocol.keyAlias(BACKEND.base, FIXTURE_SLUG)
    val controller get() = h.controller
    val view: BleView get() = h.state.ble

    init {
        val put = h.server.presencePut
        h.server.presencePut = { r ->
            log += if (r.jsonObject["ble"] != null) "PUT presence ble=${(r.jsonObject["ble"] as JsonPrimitive).content}" else "PUT presence"
            put(r)
        }
    }

    fun now(): Long = h.clock.now().toEpochMilliseconds()

    /** A visible profile with presence on in Hallway, ready to turn Bluetooth on; requests so far forgotten. */
    suspend fun ready(caps: Capabilities = BLE_ON, zone: String = "Hallway", spot: String = "Green jacket") {
        h.start(caps)
        h.visible()
        check(controller.turnOnPresence(zone, spot) == null)
        test.runCurrent()
        h.http.sent.clear()
        log.clear()
    }

    /** [ready], then Bluetooth on; the order log is followed from here, and the requests so far are forgotten. */
    suspend fun on(caps: Capabilities = BLE_ON) {
        ready(caps)
        radio.log = log
        keys.log = log
        h.notifier.log = log
        check(controller.turnOnBluetooth() == BleOutcome.On)
        test.runCurrent()
        h.http.sent.clear()
    }

    /** The current key's token of window [w], as this phone derives it. */
    fun ownToken(w: Long): ByteArray = BleProtocol.tokenOf(keys.hmac(alias, BleProtocol.tokenMessage(w))!!)

    /** Sightings requests sent so far. */
    fun sightings(): List<SentRequest> = h.sent("POST", "/api/presence/sightings")

    /** The tokens of a sightings request with their RSSI, in the request's order. */
    fun reported(r: SentRequest): List<Pair<String, Int>> =
        (r.jsonObject["sightings"] as JsonArray).map { (it as JsonObject).let { o -> (o["token"] as JsonPrimitive).content to (o["rssi"] as JsonPrimitive).int } }

    fun presencePuts(): List<SentRequest> = h.sent("PUT", "/api/presence")

    /** A sightings answer naming [nearby] (JSON objects) with the current key id, or [keyId]. */
    fun answer(vararg nearby: String, keyId: String? = h.server.bleKeyId()): HttpResponse =
        FakeApiHttp.json(200, """{"nearby":[${nearby.joinToString(",")}]${if (keyId != null) ""","ble_key_id":"$keyId"""" else ""}}""")
}

/** A payload of another phone: a v1 payload of a token made of [seed]. */
fun otherPayload(seed: Int): ByteArray = BleProtocol.encodePayload(otherToken(seed))

fun otherToken(seed: Int): ByteArray = ByteArray(16) { i -> (seed * 31 + i * 7 + 3).toByte() }

fun tokenText(seed: Int): String = BleProtocol.encodeToken(otherToken(seed))

/** A nearby person as the sightings answer carries one. */
fun nearby(ref: String, evidence: String? = null, speak: String? = "eBPF", zone: String? = null): String =
    """{"ref":"$ref","display_name":"Someone","evidence":${evidence?.let { "\"$it\"" } ?: "null"},""" +
        """"speak_topics":[${speak?.let { """{"topic_id":"t1","label":"$it"}""" } ?: ""}],"zone":${zone?.let { "\"$it\"" } ?: "null"}}"""
