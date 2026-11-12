package app.conferencecaddie.shared.ble

import app.conferencecaddie.shared.bundle.Sha256
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/**
 * Bluetooth derived tokens v1 (docs/contracts/ble-tokens.md), the parts a phone needs: the window of
 * a moment, the message whose HMAC under the session key is the token, the 17-byte payload sent over
 * the air, and reading a payload heard from another phone. The reference implementation is
 * `contracts/js/ble-token.mjs`; the golden vectors in `contracts/fixtures/ble/` are checked against
 * this object in the common tests.
 *
 * The key itself never appears here: a [BleKeyStore] holds it and computes the HMAC, so on Android
 * it stays inside the Keystore.
 */
@OptIn(ExperimentalEncodingApi::class)
object BleProtocol {
    /** The service UUID every phone advertises and scans for. */
    const val SERVICE_UUID = "e52c391c-b926-4856-9a38-d46c3c10c733"

    /** The read-only GATT characteristic that serves the payload, inside [SERVICE_UUID]. */
    const val TOKEN_CHARACTERISTIC_UUID = "944ddf9a-6eea-4583-978f-9da68fc3f562"

    /** Token window in seconds: the token changes at every multiple of it in Unix time. */
    const val WINDOW_S = 600L

    const val KEY_BYTES = 32
    const val TOKEN_BYTES = 16

    /** The format byte of a v1 payload. */
    const val PAYLOAD_FORMAT_V1: Byte = 0x01

    /** A v1 payload: the format byte, then the 16 token bytes. */
    const val PAYLOAD_V1_BYTES = 1 + TOKEN_BYTES

    /** The ASCII label of the token HMAC message. */
    const val TOKEN_LABEL = "caddie-ble-v1"

    /** The ASCII label of the key id HMAC message. */
    const val KEY_ID_LABEL = "caddie-ble-key-id-v1"

    /** A sighting older than this is dropped instead of sent (ble-tokens.md, Over the air). */
    const val SIGHTING_MAX_AGE_MS = 300_000L

    /** At most this many tokens in one sightings report. */
    const val MAX_SIGHTINGS = 50

    private val base64Url = Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT)
    private val tokenLabel = TOKEN_LABEL.encodeToByteArray()
    private val keyIdLabel = KEY_ID_LABEL.encodeToByteArray()

    /** The window of [unixSeconds] (seconds since 1970, floored): `floor(unix_seconds / 600)`. */
    fun windowOf(unixSeconds: Long): Long {
        require(unixSeconds >= 0) { "unixSeconds must not be negative" }
        return unixSeconds / WINDOW_S
    }

    /** The window of a time in epoch milliseconds. */
    fun windowAtMillis(epochMillis: Long): Long = windowOf(epochMillis.floorDiv(1000L))

    /** Epoch milliseconds at which window [w] starts. */
    fun windowStartMillis(w: Long): Long = w * WINDOW_S * 1000L

    /**
     * The 21-byte message of window [w]: the 13 ASCII bytes `caddie-ble-v1`, then `w` as an unsigned
     * 64-bit big-endian integer. A Kotlin Long carries the same bit pattern as the contract's uint64,
     * so `w = 2^64 - 1` is passed as -1.
     */
    fun tokenMessage(w: Long): ByteArray {
        val out = ByteArray(tokenLabel.size + 8)
        tokenLabel.copyInto(out)
        for (i in 0 until 8) out[tokenLabel.size + i] = (w ushr (56 - 8 * i)).toByte()
        return out
    }

    /** The message whose HMAC under the key names the key: the ASCII bytes `caddie-ble-key-id-v1`. */
    fun keyIdMessage(): ByteArray = keyIdLabel.copyOf()

    /** The token in a full 32-byte HMAC of [tokenMessage]: its first 16 bytes. */
    fun tokenOf(hmac: ByteArray): ByteArray {
        require(hmac.size == 32) { "an HMAC-SHA256 is 32 bytes" }
        return hmac.copyOf(TOKEN_BYTES)
    }

    /** `ble_key_id` from the full HMAC of [keyIdMessage]: base64url of its first 8 bytes, 11 characters. */
    fun keyIdOf(hmac: ByteArray): String {
        require(hmac.size == 32) { "an HMAC-SHA256 is 32 bytes" }
        return base64Url.encode(hmac, 0, 8)
    }

    /** The v1 payload of [token]: `0x01` followed by the 16 token bytes. */
    fun encodePayload(token: ByteArray): ByteArray {
        require(token.size == TOKEN_BYTES) { "a token is 16 bytes" }
        val out = ByteArray(PAYLOAD_V1_BYTES)
        out[0] = PAYLOAD_FORMAT_V1
        token.copyInto(out, 1)
        return out
    }

    /** The token in a payload heard from another phone, and which kind it is. */
    class Heard(val token: ByteArray, val legacy: Boolean) {
        /** The token as the sightings request carries it: base64url without padding, 22 characters. */
        val text: String get() = encodeToken(token)
    }

    /**
     * Reads service data or a GATT value heard from another phone: a 17-byte value starting with
     * `0x01` is a v1 token, a bare 16-byte value is a legacy server-minted token (reported the same
     * way), and anything else is ignored, so a later format cannot be misread.
     */
    fun decodePayload(bytes: ByteArray?): Heard? {
        if (bytes == null) return null
        if (bytes.size == PAYLOAD_V1_BYTES && bytes[0] == PAYLOAD_FORMAT_V1) return Heard(bytes.copyOfRange(1, PAYLOAD_V1_BYTES), legacy = false)
        if (bytes.size == TOKEN_BYTES) return Heard(bytes.copyOf(), legacy = true)
        return null
    }

    /** A token as the sightings request carries it: base64url without padding, 22 characters. */
    fun encodeToken(token: ByteArray): String {
        require(token.size == TOKEN_BYTES) { "a token is 16 bytes" }
        return base64Url.encode(token)
    }

    /**
     * The 32 bytes of a `ble_key` from a presence answer (base64url without padding, 43 characters),
     * or null when the text is not exactly that in canonical form.
     */
    fun decodeKey(text: String?): ByteArray? {
        if (text == null || text.length != 43 || !text.all { it.isLetterOrDigit() && it.code < 128 || it == '-' || it == '_' }) return null
        val bytes = try {
            base64Url.decode(text)
        } catch (e: IllegalArgumentException) {
            return null
        }
        if (bytes.size != KEY_BYTES || base64Url.encode(bytes) != text) return null
        return bytes
    }

    /** True for a well-formed `ble_key_id`: 11 base64url characters. */
    fun isKeyId(text: String?): Boolean =
        text != null && text.length == 11 && text.all { (it.isLetterOrDigit() && it.code < 128) || it == '-' || it == '_' }

    /**
     * The [BleKeyStore] alias of the session key of conference [slug] at the backend with normalised
     * base [backendBase]: a hash, so the platform key store does not list the backends or
     * conferences the person used.
     */
    fun keyAlias(backendBase: String, slug: String): String = "caddie-ble-" + Sha256.hex("$backendBase#$slug").take(32)
}

/** HMAC-SHA256 (RFC 2104) on the plain-Kotlin [Sha256], for platforms whose key store holds key bytes. */
object HmacSha256 {
    private const val BLOCK = 64

    fun mac(key: ByteArray, message: ByteArray): ByteArray {
        val k = if (key.size > BLOCK) Sha256.digest(key) else key
        val inner = ByteArray(BLOCK + message.size)
        val outer = ByteArray(BLOCK + 32)
        for (i in 0 until BLOCK) {
            val b = if (i < k.size) k[i].toInt() else 0
            inner[i] = (b xor 0x36).toByte()
            outer[i] = (b xor 0x5c).toByte()
        }
        message.copyInto(inner, BLOCK)
        Sha256.digest(inner).copyInto(outer, BLOCK)
        return Sha256.digest(outer)
    }
}
