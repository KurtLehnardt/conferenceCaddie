package app.conferencecaddie.shared

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * The effective feature set of one backend, read from its capabilities document
 * (docs/contracts/capabilities.md; reference `effectiveCapabilities()` in
 * contracts/js/capabilities.mjs). Every flag shows or hides whole screens and controls.
 *
 * Build one with [effective] from a document that [negotiate] accepted. The rules are the
 * contract's consumer rules: unknown fields are ignored, an unknown enum value becomes the most
 * conservative known value, a missing field is off, numbers out of range are clamped or take their
 * defaults, and dependent features turn off with what they need.
 *
 * This is what the backend offers. What this build of the app can use of it is [forThisApp].
 */
data class Capabilities(
    val apiVersion: Int = 1,
    val tier: Tier = Tier.Unknown,
    val talks: Talks = Talks(),
    val people: People = People(),
    val ble: Ble = Ble(),
    val push: Push = Push(),
    val imports: Imports = Imports(),
) {
    /** A label for people. No feature is ever gated on it. */
    enum class Tier(val code: String) { Demo("demo"), Free("free"), Paid("paid"), Unknown("unknown") }

    enum class Semantic(val code: String) { Server("server"), Client("client"), Off("off") }

    enum class Live(val code: String) { WebSocket("websocket"), Poll("poll") }

    enum class BleMode(val code: String) { DerivedV1("derived-v1"), ServerRotate("server-rotate"), None("none") }

    enum class ImportSite(val code: String) { Device("device"), Server("server") }

    data class Talks(
        /** An https URL ending in '/', or null when the backend publishes no bundles. */
        val bundleBase: String? = null,
        val serverSearch: Boolean = false,
    )

    data class People(
        val enabled: Boolean = false,
        val semantic: Semantic = Semantic.Off,
        val presence: Boolean = false,
        val gpsBands: Boolean = false,
        val meets: Boolean = false,
        val circles: Boolean = false,
        val reports: Boolean = false,
        val live: Live = Live.Poll,
    )

    data class Ble(
        val mode: BleMode = BleMode.None,
        val serviceUuid: String = SERVICE_UUID,
        val nearRssi: Int = -75,
        val windowSeconds: Int = 600,
        val sightingsMinIntervalSeconds: Int = 60,
        val colocationRequired: Boolean = true,
    )

    data class Push(
        val apns: Boolean = false,
        val fcm: Boolean = false,
        val webpush: Boolean = false,
    )

    data class Imports(
        val github: ImportSite = ImportSite.Device,
        val schedule: ImportSite = ImportSite.Device,
    )

    /**
     * What this build of the app can use of these capabilities. The app implements only the
     * derived-v1 Bluetooth mode (tokens derived on the phone from a key), so the legacy
     * server-minted tokens (`server-rotate`) are never used here: the Capacitor app keeps them.
     * It does not compute people vectors either, so `semantic: client` is read as off, as the
     * contract asks of a client that does not implement it.
     */
    fun forThisApp(): Capabilities = copy(
        people = if (people.semantic == Semantic.Client) people.copy(semantic = Semantic.Off) else people,
        ble = if (ble.mode == BleMode.DerivedV1) ble else ble.copy(mode = BleMode.None),
    )

    /** The document form, as the contract's fixtures write an effective feature set. */
    fun toJson(): JsonObject = buildJsonObject {
        put("api_version", apiVersion)
        put("tier", tier.code)
        putJsonObject("talks") {
            put("bundle_base", talks.bundleBase?.let { JsonPrimitive(it) } ?: JsonNull)
            put("server_search", talks.serverSearch)
        }
        putJsonObject("people") {
            put("enabled", people.enabled)
            put("semantic", people.semantic.code)
            put("presence", people.presence)
            put("gps_bands", people.gpsBands)
            put("meets", people.meets)
            put("circles", people.circles)
            put("reports", people.reports)
            put("live", people.live.code)
        }
        putJsonObject("ble") {
            put("mode", ble.mode.code)
            put("service_uuid", ble.serviceUuid)
            put("near_rssi", ble.nearRssi)
            put("window_s", ble.windowSeconds)
            put("sightings_min_interval_s", ble.sightingsMinIntervalSeconds)
            put("colocation_required", ble.colocationRequired)
        }
        putJsonObject("push") {
            put("apns", push.apns)
            put("fcm", push.fcm)
            put("webpush", push.webpush)
        }
        putJsonObject("imports") {
            put("github", imports.github.code)
            put("schedule", imports.schedule.code)
        }
    }

    /** The outcome of [negotiate]. */
    sealed interface Negotiation {
        /** The document is usable at major [version]. */
        data class Ok(val version: Int) : Negotiation

        /** No usable `api_version`; `{}` is invalid. */
        data object Invalid : Negotiation

        /** The backend serves only majors newer than this app knows: "update the app". */
        data object UpdateApp : Negotiation
    }

    companion object {
        /** The Bluetooth service UUID, fixed in v1. */
        const val SERVICE_UUID = "e52c391c-b926-4856-9a38-d46c3c10c733"

        /** The major versions of the capabilities document this app implements. */
        val CLIENT_API_VERSIONS: List<Int> = listOf(1)

        /** The range `near_rssi` is clamped to. */
        val NEAR_RSSI_RANGE: IntRange = -100..-30

        /** A backend with no usable document and no legacy answer: everything off. */
        val None = Capabilities()

        /**
         * The effective capabilities of a backend that has no capabilities document but answers
         * `GET /api/health` with `{ "ok": true }`: today's tier 3 server before Phase 1. Equal to
         * the contract's `legacy-effective.json`, Bluetooth in `server-rotate` mode included;
         * [forThisApp] is what filters that mode out.
         */
        val Legacy = Capabilities(
            apiVersion = 1,
            tier = Tier.Paid,
            talks = Talks(bundleBase = null, serverSearch = true),
            people = People(
                enabled = true,
                semantic = Semantic.Server,
                presence = true,
                gpsBands = true,
                meets = true,
                circles = true,
                reports = true,
                live = Live.Poll,
            ),
            ble = Ble(
                mode = BleMode.ServerRotate,
                serviceUuid = SERVICE_UUID,
                nearRssi = -75,
                windowSeconds = 600,
                sightingsMinIntervalSeconds = 10,
                colocationRequired = false,
            ),
            push = Push(apns = false, fcm = false, webpush = true),
            imports = Imports(github = ImportSite.Server, schedule = ImportSite.Server),
        )

        private val json = Json { ignoreUnknownKeys = true }

        /** Parses [text] as JSON, or returns null when it is not JSON. */
        fun parseJson(text: String): JsonElement? = try {
            json.parseToJsonElement(text)
        } catch (_: Exception) {
            null
        }

        /**
         * Picks the major version to speak with a backend (`negotiate()` in the reference): the
         * highest major in [supported] within `min_api_version..api_version`.
         */
        fun negotiate(doc: JsonElement?, supported: List<Int> = CLIENT_API_VERSIONS): Negotiation {
            val o = doc.asObject() ?: return Negotiation.Invalid
            val max = o["api_version"].asInteger() ?: return Negotiation.Invalid
            if (max < 1) return Negotiation.Invalid
            val minRaw = o["min_api_version"].asInteger()
            val min = if (minRaw != null && minRaw >= 1 && minRaw <= max) minRaw else max
            val usable = supported.filter { it in min..max }
            if (usable.isEmpty()) {
                return if (max > (supported.maxOrNull() ?: 0)) Negotiation.UpdateApp else Negotiation.Invalid
            }
            return Negotiation.Ok(usable.max())
        }

        /**
         * The feature set a v1 client acts on, from a document [negotiate] accepted.
         *
         * [allowLocalHttpBundleBase] is for debug builds only: it also accepts a bundle base of
         * plain http on the hosts [BackendUrl] accepts over http in debug builds, so a developer can
         * serve bundles from their own machine. Release builds always pass false.
         */
        fun effective(doc: JsonElement?, allowLocalHttpBundleBase: Boolean = false): Capabilities {
            val d = doc.asObject() ?: JsonObject(emptyMap())
            val talks = d["talks"].asObject() ?: JsonObject(emptyMap())
            val people = d["people"].asObject() ?: JsonObject(emptyMap())
            val ble = d["ble"].asObject() ?: JsonObject(emptyMap())
            val push = d["push"].asObject() ?: JsonObject(emptyMap())
            val imports = d["imports"].asObject() ?: JsonObject(emptyMap())

            val bundleBase = talks["bundle_base"].asString()?.takeIf { isBundleBase(it, allowLocalHttpBundleBase) }
            // A backend that cannot take reports must not show other people's text at all.
            val peopleOn = people["enabled"].isTrue() && people["reports"].isTrue()
            val presence = peopleOn && people["presence"].isTrue()
            var mode = oneOf(ble["mode"], BleMode.entries, BleMode::code) ?: BleMode.None
            if (!presence) mode = BleMode.None
            val windowS = if (mode == BleMode.DerivedV1) 600 else intIn(ble["window_s"], 60, 3600, 600)
            val intervalMax = if (mode == BleMode.DerivedV1) windowS / 2 else 1800

            return Capabilities(
                apiVersion = 1,
                tier = oneOf(d["tier"], listOf(Tier.Demo, Tier.Free, Tier.Paid), Tier::code) ?: Tier.Unknown,
                talks = Talks(bundleBase = bundleBase, serverSearch = talks["server_search"].isTrue()),
                people = People(
                    enabled = peopleOn,
                    semantic = if (peopleOn) oneOf(people["semantic"], Semantic.entries, Semantic::code) ?: Semantic.Off else Semantic.Off,
                    presence = presence,
                    gpsBands = presence && people["gps_bands"].isTrue(),
                    meets = presence && people["meets"].isTrue(),
                    circles = peopleOn && people["circles"].isTrue(),
                    reports = peopleOn,
                    live = if (peopleOn) oneOf(people["live"], Live.entries, Live::code) ?: Live.Poll else Live.Poll,
                ),
                ble = Ble(
                    mode = mode,
                    serviceUuid = SERVICE_UUID,
                    nearRssi = ble["near_rssi"].asInteger()
                        ?.coerceIn(NEAR_RSSI_RANGE.first.toLong(), NEAR_RSSI_RANGE.last.toLong())?.toInt() ?: -75,
                    windowSeconds = windowS,
                    sightingsMinIntervalSeconds = intIn(ble["sightings_min_interval_s"], 10, intervalMax, minOf(60, intervalMax)),
                    // On unless the backend says false: it is a protection.
                    colocationRequired = !ble["colocation_required"].isFalse(),
                ),
                push = Push(apns = push["apns"].isTrue(), fcm = push["fcm"].isTrue(), webpush = push["webpush"].isTrue()),
                imports = Imports(
                    github = oneOf(imports["github"], ImportSite.entries, ImportSite::code) ?: ImportSite.Device,
                    schedule = oneOf(imports["schedule"], ImportSite.entries, ImportSite::code) ?: ImportSite.Device,
                ),
            )
        }

        /**
         * True when [value] may be used as `talks.bundle_base`: an https URL that ends in '/', with
         * no credentials, query or fragment. The URL rules are [BackendUrl]'s, which are stricter
         * than the reference's WHATWG parser in the ways listed there.
         */
        fun isBundleBase(value: String, allowLocalHttp: Boolean = false): Boolean {
            if (value.isEmpty() || value != value.trim() || !value.endsWith("/")) return false
            return BackendUrl.normalise(value, allowLocalHttp = allowLocalHttp) is BackendUrl.Valid
        }

        private fun <T> oneOf(value: JsonElement?, allowed: List<T>, code: (T) -> String): T? {
            val s = value.asString() ?: return null
            return allowed.firstOrNull { code(it) == s }
        }

        private fun intIn(value: JsonElement?, min: Int, max: Int, fallback: Int): Int {
            val v = value.asInteger() ?: return fallback
            return if (v >= min && v <= max) v.toInt() else fallback
        }
    }
}
