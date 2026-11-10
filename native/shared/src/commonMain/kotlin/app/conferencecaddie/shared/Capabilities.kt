package app.conferencecaddie.shared

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * What a backend can do, read from `GET {backend}/api/capabilities` (tiers 2 and 3) or the static
 * `capabilities.json` (tier 1). Every flag shows or hides whole screens and controls in the apps.
 *
 * This mirrors the illustrative shape in docs/NATIVE_PLAN.md (section 7.2). It is not yet a frozen
 * contract: field names follow that sketch so the apps and backends can converge on it in Phase 1.
 * Every field has a default, so a document that leaves a section out still parses.
 */
@Serializable
data class Capabilities(
    @SerialName("api_version") val apiVersion: Int = 1,
    val tier: Tier = Tier.Demo,
    val talks: Talks = Talks(),
    val people: People = People(),
    val ble: Ble = Ble(),
    val push: Push = Push(),
    val imports: Imports = Imports(),
) {
    @Serializable
    enum class Tier {
        @SerialName("demo") Demo,
        @SerialName("free") Free,
        @SerialName("paid") Paid,
    }

    @Serializable
    data class Talks(
        @SerialName("bundle_base") val bundleBase: String? = null,
        @SerialName("server_search") val serverSearch: Boolean = false,
    )

    @Serializable
    data class People(
        val enabled: Boolean = false,
        val semantic: String = "off",
        val presence: Boolean = false,
        @SerialName("gps_bands") val gpsBands: Boolean = false,
        val meets: Boolean = false,
        val circles: Boolean = false,
        val reports: Boolean = false,
        val live: String = "poll",
    )

    @Serializable
    data class Ble(
        val mode: String = "none",
        @SerialName("service_uuid") val serviceUuid: String? = null,
        @SerialName("near_rssi") val nearRssi: Int = -75,
        @SerialName("window_s") val windowSeconds: Int = 600,
        @SerialName("sightings_min_interval_s") val sightingsMinIntervalSeconds: Int = 60,
    )

    @Serializable
    data class Push(
        val apns: Boolean = false,
        val fcm: Boolean = false,
        val webpush: Boolean = false,
    )

    @Serializable
    data class Imports(
        val github: String = "device",
        val schedule: String = "device",
    )

    companion object {
        /** The tier 1 demo: talk features only, no people features. */
        val Demo = Capabilities()

        /**
         * A backend that serves no capabilities document (today's tier 3 server, before Phase 1)
         * is treated as legacy with the full current feature set.
         */
        val Legacy = Capabilities(
            tier = Tier.Paid,
            talks = Talks(serverSearch = true),
            people = People(
                enabled = true,
                semantic = "server",
                presence = true,
                gpsBands = true,
                meets = true,
                circles = true,
                reports = true,
                live = "poll",
            ),
            // The native apps implement only derived-v1 tokens; today's server-issued tokens stay
            // with the Capacitor app, so a legacy backend gets no Bluetooth in the native apps.
            ble = Ble(mode = "none"),
            push = Push(webpush = true),
            imports = Imports(github = "server", schedule = "server"),
        )

        /**
         * Lenient on purpose: a newer backend may add fields or new enum values. Unknown keys are
         * ignored and an unknown tier falls back to the default instead of failing the whole parse.
         */
        private val json = Json {
            ignoreUnknownKeys = true
            coerceInputValues = true
        }

        fun parse(document: String): Capabilities = json.decodeFromString(serializer(), document)
    }
}
