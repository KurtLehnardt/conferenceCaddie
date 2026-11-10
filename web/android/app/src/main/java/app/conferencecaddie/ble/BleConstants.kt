package app.conferencecaddie.ble

import java.util.UUID

/**
 * Shared constants of the Bluetooth proximity feature. The service UUID is the same value as
 * BLE_SERVICE_UUID in server/ble.mjs and docs/CONTRACT.md; a phone advertises it with its current
 * 16-byte token as service data and scans only for it.
 */
object BleConstants {
    val SERVICE_UUID: UUID = UUID.fromString("e52c391c-b926-4856-9a38-d46c3c10c733")

    /** The token is 16 random bytes, base64url without padding (22 characters) on the wire to JS. */
    const val TOKEN_BYTES = 16
    const val TOKEN_BASE64URL_LENGTH = 22

    /** Sightings are emitted to JS at most once per window, deduped per token (strongest RSSI). */
    const val WINDOW_MS = 10_000L

    /**
     * A token lives 10 minutes on the server. If the web app has not rotated it by then (the app
     * was closed or lost the connection), the service stops rather than advertise a dead code.
     */
    const val STALE_MS = 11 * 60_000L

    /** Hardware batching delay for the scanner where it is supported. */
    const val BATCH_MS = 5_000L

    /** At most this many tokens per sightings event; the server accepts the same number. */
    const val MAX_SIGHTINGS = 50

    /** Tokens weaker than this are not even sent; the server's own threshold is BLE_NEAR_RSSI (-75). */
    const val MIN_REPORT_RSSI = -90

    const val CHANNEL_PRESENCE = "caddie_ble_presence"
    const val CHANNEL_NEARBY = "caddie_ble_nearby"
    const val NOTIFICATION_PRESENCE = 4101
    const val NOTIFICATION_NEARBY = 4102

    /** Extra on the launch intent of a tapped nearby notification; the plugin hands it to JS. */
    const val EXTRA_TAP = "caddie_ble_tap"
}
