package app.conferencecaddie.shared.ble

import app.conferencecaddie.shared.fixtures.Fixtures
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The protocol against the contract's golden vectors (contracts/fixtures/ble/golden-vectors.v1.json),
 * which the reference implementation and openssl computed independently.
 */
class BleProtocolTest {
    private val golden = Fixtures.json("ble/golden-vectors.v1.json").jsonObject

    private fun JsonObject.s(name: String): String = this[name]!!.jsonPrimitive.content

    private fun hex(text: String): ByteArray = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun ByteArray.hex(): String = joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    // A window index is a decimal uint64; a Long carries the same bits.
    private fun u64(text: String): Long = text.toULong().toLong()

    @Test
    fun constantsMatchTheFixture() {
        val c = golden["constants"]!!.jsonObject
        assertEquals(c.s("token_label"), BleProtocol.TOKEN_LABEL)
        assertEquals(c.s("key_id_label"), BleProtocol.KEY_ID_LABEL)
        assertEquals(c.s("window_s").toLong(), BleProtocol.WINDOW_S)
        assertEquals(c.s("token_bytes").toInt(), BleProtocol.TOKEN_BYTES)
        assertEquals(c.s("key_bytes").toInt(), BleProtocol.KEY_BYTES)
        assertEquals(c.s("service_uuid"), BleProtocol.SERVICE_UUID)
        assertEquals(c.s("token_characteristic_uuid"), BleProtocol.TOKEN_CHARACTERISTIC_UUID)
        assertEquals(c.s("payload_format_v1").toInt(), BleProtocol.PAYLOAD_FORMAT_V1.toInt())
    }

    @Test
    fun windowsMatchTheFixture() {
        for (w in golden["windows"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(u64(w.s("w")), BleProtocol.windowOf(w.s("unix_seconds").toLong()), w.s("note"))
        }
        assertEquals(2990520L, BleProtocol.windowAtMillis(1_794_312_000_999L))
        assertEquals(1_794_312_000_000L, BleProtocol.windowStartMillis(2990520L))
        assertFailsWith<IllegalArgumentException> { BleProtocol.windowOf(-1) }
    }

    @Test
    fun tokenVectorsThroughTheProtocolAndTheCommonHmac() {
        val keys = golden["keys"]!!.jsonObject
        for (t in golden["tokens"]!!.jsonArray.map { it.jsonObject }) {
            val key = hex(keys[t.s("key")]!!.jsonObject.s("hex"))
            val message = BleProtocol.tokenMessage(u64(t.s("w")))
            assertEquals(t.s("message_hex"), message.hex(), "message at w = ${t.s("w")}")
            val mac = HmacSha256.mac(key, message)
            assertEquals(t.s("hmac_sha256_hex"), mac.hex(), "hmac at w = ${t.s("w")}")
            val token = BleProtocol.tokenOf(mac)
            assertEquals(t.s("token_hex"), token.hex())
            assertEquals(t.s("token_base64url"), BleProtocol.encodeToken(token))
            assertEquals(t.s("payload_hex"), BleProtocol.encodePayload(token).hex())
        }
    }

    @Test
    fun keyDerivationVectorsGiveTheKeyIdAndTokens() = runTest {
        val kd = golden["key_derivation"]!!.jsonObject
        val master = hex(kd["master_secret"]!!.jsonObject.s("hex"))
        for (case in (kd["cases"] as JsonArray).map { it.jsonObject }) {
            // The server's derivation, here only as a cross-check of the common HMAC.
            val derived = HmacSha256.mac(master, hex(case.s("key_message_hex")))
            assertEquals(case.s("ble_key_hex"), derived.hex())
            // What the device does: decode the key from the presence answer, store it, and name and
            // use it through the store.
            val key = assertNotNull(BleProtocol.decodeKey(case.s("ble_key_base64url")))
            assertContentEquals(derived, key)
            val store = InMemoryBleKeyStore()
            val alias = BleProtocol.keyAlias("https://caddie.example", "caddie-fixture-2099")
            store.put(alias, key)
            val idMac = assertNotNull(store.hmac(alias, BleProtocol.keyIdMessage()))
            assertEquals(case.s("key_id_hmac_sha256_hex"), idMac.hex())
            assertEquals(case.s("ble_key_id"), BleProtocol.keyIdOf(idMac))
            assertTrue(BleProtocol.isKeyId(case.s("ble_key_id")))
            for (t in (case["tokens"] as JsonArray).map { it.jsonObject }) {
                val mac = assertNotNull(store.hmac(alias, BleProtocol.tokenMessage(u64(t.s("w")))))
                assertEquals(t.s("token_base64url"), BleProtocol.encodeToken(BleProtocol.tokenOf(mac)))
            }
            store.remove(alias)
            assertNull(store.hmac(alias, BleProtocol.keyIdMessage()))
        }
    }

    @Test
    fun payloadsDecodeOnlyInTheTwoKnownFormats() {
        val token = ByteArray(16) { (it * 7).toByte() }
        val v1 = assertNotNull(BleProtocol.decodePayload(BleProtocol.encodePayload(token)))
        assertContentEquals(token, v1.token)
        assertEquals(false, v1.legacy)
        val legacy = assertNotNull(BleProtocol.decodePayload(token))
        assertEquals(true, legacy.legacy)
        assertEquals(BleProtocol.encodeToken(token), legacy.text)
        assertNull(BleProtocol.decodePayload(byteArrayOf(0x02) + token), "another format byte")
        assertNull(BleProtocol.decodePayload(ByteArray(15)))
        assertNull(BleProtocol.decodePayload(ByteArray(18)))
        assertNull(BleProtocol.decodePayload(null))
    }

    @Test
    fun keysDecodeOnlyFromCanonicalBase64url() {
        val good = golden["keys"]!!.jsonObject["key-a"]!!.jsonObject.s("base64url")
        assertNotNull(BleProtocol.decodeKey(good))
        assertNull(BleProtocol.decodeKey(good.dropLast(1)), "42 characters")
        assertNull(BleProtocol.decodeKey("$good="), "padding")
        assertNull(BleProtocol.decodeKey(good.replace('A', '+')), "the standard alphabet")
        // The last character carries 2 spare bits; a non-zero one is not canonical.
        assertNull(BleProtocol.decodeKey(good.dropLast(1) + "f"))
        assertNull(BleProtocol.decodeKey(null))
        assertTrue(!BleProtocol.isKeyId("Eb2uBz7W6S"))
        assertTrue(!BleProtocol.isKeyId("Eb2uBz7W6S+"))
    }

    @Test
    fun hmacPassesRfc4231() {
        // RFC 4231 test case 2 and test case 6 (a key longer than the block).
        assertEquals(
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
            HmacSha256.mac("Jefe".encodeToByteArray(), "what do ya want for nothing?".encodeToByteArray()).hex(),
        )
        assertEquals(
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
            HmacSha256.mac(ByteArray(131) { 0xaa.toByte() }, "Test Using Larger Than Block-Size Key - Hash Key First".encodeToByteArray()).hex(),
        )
    }

    @Test
    fun aliasesAreStablePerBackendAndConference() {
        val a = BleProtocol.keyAlias("https://a.example", "conf-2026")
        assertEquals(a, BleProtocol.keyAlias("https://a.example", "conf-2026"))
        assertTrue(a != BleProtocol.keyAlias("https://a.example/x", "conf-2026"))
        assertTrue(a != BleProtocol.keyAlias("https://a.example", "conf-2027"))
        assertTrue(Regex("caddie-ble-[0-9a-f]{32}").matches(a))
    }
}
