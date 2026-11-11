package app.conferencecaddie.shared.ble

import app.conferencecaddie.shared.KeychainException
import app.conferencecaddie.shared.fixtures.Fixtures
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The iOS Bluetooth key store. Gradle runs these tests as a plain process in a standalone simulator,
 * which has no Keychain (see IosSecureStoreTest), so the store's logic runs here over a map; the
 * Keychain itself is checked here when the process may use it (it prints SKIPPED otherwise) and in
 * the app with `-caddie.selftest blekeys`.
 */
class IosBleKeyStoreTest {
    private val golden = Fixtures.json("ble/golden-vectors.v1.json").jsonObject
    private val backing = MapBacking()
    private val store = IosBleKeyStore(backing)
    private val alias = BleProtocol.keyAlias("https://caddie.example.org", "caddie-fixture-2099")
    private val otherAlias = BleProtocol.keyAlias("https://caddie.example.org/other", "caddie-fixture-2099")

    /** A map in place of the Keychain, which counts its reads and can fail like the Keychain does. */
    private class MapBacking : BleKeyBacking {
        val items = HashMap<String, ByteArray>()
        var reads = 0
        var failure: Int? = null

        override fun read(alias: String): ByteArray? {
            reads++
            failure?.let { throw KeychainException("read", it) }
            return items[alias]?.copyOf()
        }

        override fun write(alias: String, key: ByteArray) {
            failure?.let { throw KeychainException("write", it) }
            items[alias] = key.copyOf()
        }

        override fun delete(alias: String) {
            failure?.let { throw KeychainException("delete", it) }
            items.remove(alias)
        }
    }

    private fun JsonObject.s(name: String): String = this[name]!!.jsonPrimitive.content

    private fun hex(text: String): ByteArray = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun ByteArray?.hex(): String? = this?.joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    // A window index is a decimal uint64; a Long carries the same bits (2^64 - 1 is -1).
    private fun u64(text: String): Long = text.toULong().toLong()

    private fun key(name: String): ByteArray = hex(golden["keys"]!!.jsonObject[name]!!.jsonObject.s("hex"))

    @Test
    fun tokenVectorsOfBothKeysAtEveryWindow() = runTest {
        val tokens = golden["tokens"]!!.jsonArray.map { it.jsonObject }
        assertEquals(14, tokens.size)
        for (t in tokens) {
            store.put(alias, key(t.s("key")))
            val mac = store.hmac(alias, BleProtocol.tokenMessage(u64(t.s("w"))))
            assertEquals(t.s("hmac_sha256_hex"), mac.hex(), "${t.s("key")} at w = ${t.s("w")}")
            val token = BleProtocol.tokenOf(mac!!)
            assertEquals(t.s("token_hex"), token.hex())
            assertEquals(t.s("payload_hex"), BleProtocol.encodePayload(token).hex())
        }
    }

    @Test
    fun theLastWindowIsMinusOne() = runTest {
        val last = golden["tokens"]!!.jsonArray.map { it.jsonObject }.filter { it.s("w") == "18446744073709551615" }
        assertEquals(setOf("key-a", "key-b"), last.map { it.s("key") }.toSet())
        for (t in last) {
            store.put(alias, key(t.s("key")))
            assertEquals(t.s("hmac_sha256_hex"), store.hmac(alias, BleProtocol.tokenMessage(-1L)).hex())
        }
    }

    @Test
    fun keyIdsAndTokensOfTheKeyDerivationCases() = runTest {
        val cases = golden["key_derivation"]!!.jsonObject["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            // The key arrives as the presence answer's base64url text.
            val key = assertNotNull(BleProtocol.decodeKey(case.s("ble_key_base64url")))
            assertEquals(case.s("ble_key_hex"), key.hex())
            store.put(alias, key)
            val idMac = store.hmac(alias, BleProtocol.keyIdMessage())
            assertEquals(case.s("key_id_hmac_sha256_hex"), idMac.hex())
            assertEquals(case.s("ble_key_id"), BleProtocol.keyIdOf(idMac!!))
            for (t in case["tokens"]!!.jsonArray.map { it.jsonObject }) {
                val mac = store.hmac(alias, BleProtocol.tokenMessage(u64(t.s("w"))))
                assertEquals(t.s("hmac_sha256_hex"), mac.hex())
                assertEquals(t.s("token_base64url"), BleProtocol.encodeToken(BleProtocol.tokenOf(mac!!)))
            }
        }
    }

    @Test
    fun aMissingKeyGivesNull() {
        assertNull(store.hmac(alias, BleProtocol.tokenMessage(0)))
    }

    @Test
    fun putReplacesTheKey() = runTest {
        val message = BleProtocol.tokenMessage(2990520)
        store.put(alias, key("key-a"))
        val a = store.hmac(alias, message)
        store.put(alias, key("key-b"))
        assertContentEquals(HmacSha256.mac(key("key-b"), message), store.hmac(alias, message))
        assertContentEquals(key("key-b"), backing.items[alias])
        // Another store over the same items (the app after a relaunch) sees the replacement too.
        assertContentEquals(store.hmac(alias, message), IosBleKeyStore(backing).hmac(alias, message))
        assertTrue(a.hex() != store.hmac(alias, message).hex())
    }

    @Test
    fun removeForgetsTheKeyAndLeavesOthers() = runTest {
        val message = BleProtocol.tokenMessage(1)
        store.put(alias, key("key-a"))
        store.put(otherAlias, key("key-b"))
        assertNotNull(store.hmac(alias, message))
        store.remove(alias)
        assertNull(store.hmac(alias, message))
        assertNull(backing.items[alias])
        assertContentEquals(HmacSha256.mac(key("key-b"), message), store.hmac(otherAlias, message))
        store.remove(alias)
        assertNull(store.hmac(alias, message))
    }

    @Test
    fun theKeyIsReadOnceThenCached() = runTest {
        store.put(alias, key("key-a"))
        val relaunched = IosBleKeyStore(backing)
        val before = backing.reads
        repeat(5) { relaunched.hmac(alias, BleProtocol.tokenMessage(it.toLong())) }
        assertEquals(before + 1, backing.reads)
        // The store that wrote the key never reads it back.
        repeat(5) { store.hmac(alias, BleProtocol.tokenMessage(it.toLong())) }
        assertEquals(before + 1, backing.reads)
    }

    @Test
    fun aKeychainFailureGivesNullAndIsNotRemembered() = runTest {
        backing.items[alias] = key("key-a")
        // errSecInteractionNotAllowed: the phone has not been unlocked since it started.
        backing.failure = -25308
        assertNull(store.hmac(alias, BleProtocol.tokenMessage(0)))
        backing.failure = null
        assertContentEquals(HmacSha256.mac(key("key-a"), BleProtocol.tokenMessage(0)), store.hmac(alias, BleProtocol.tokenMessage(0)))
    }

    @Test
    fun aFailedWriteKeepsThePreviousKey() = runTest {
        store.put(alias, key("key-a"))
        backing.failure = -25308
        assertFailsWith<KeychainException> { store.put(alias, key("key-b")) }
        backing.failure = null
        assertContentEquals(HmacSha256.mac(key("key-a"), BleProtocol.tokenMessage(0)), store.hmac(alias, BleProtocol.tokenMessage(0)))
    }

    @Test
    fun aFailedRemoveIsThrownAndTheItemIsReadAgain() = runTest {
        store.put(alias, key("key-a"))
        backing.failure = -25308
        assertFailsWith<KeychainException> { store.remove(alias) }
        backing.failure = null
        val reads = backing.reads
        // Still in the Keychain, so still there; but read from it, not from the cache.
        assertNotNull(store.hmac(alias, BleProtocol.tokenMessage(0)))
        assertEquals(reads + 1, backing.reads)
    }

    @Test
    fun aStoredValueOfAnotherLengthIsNoKey() {
        backing.items[alias] = ByteArray(16)
        assertNull(store.hmac(alias, BleProtocol.tokenMessage(0)))
    }

    @Test
    fun onlyThirtyTwoByteKeysAreStored() = runTest {
        assertFailsWith<IllegalArgumentException> { store.put(alias, ByteArray(31)) }
        assertFailsWith<IllegalArgumentException> { store.put(alias, ByteArray(33)) }
        assertTrue(backing.items.isEmpty())
    }

    @Test
    fun theCallersArrayIsCopied() = runTest {
        val bytes = key("key-a")
        store.put(alias, bytes)
        bytes.fill(0)
        assertContentEquals(HmacSha256.mac(key("key-a"), BleProtocol.tokenMessage(0)), store.hmac(alias, BleProtocol.tokenMessage(0)))
    }

    @Test
    fun hmacFromManyThreadsWhileTheKeyChanges() = runTest {
        val message = BleProtocol.tokenMessage(2990520)
        val expected = setOf(HmacSha256.mac(key("key-a"), message).hex(), HmacSha256.mac(key("key-b"), message).hex(), null)
        withContext(Dispatchers.Default) {
            coroutineScope {
                val readers = (1..4).map {
                    launch {
                        repeat(300) {
                            val mac = store.hmac(alias, message).hex()
                            assertTrue(mac in expected, "an HMAC under neither key")
                        }
                    }
                }
                launch {
                    repeat(100) {
                        store.put(alias, key(if (it % 2 == 0) "key-a" else "key-b"))
                        if (it % 10 == 9) store.remove(alias)
                    }
                }
                readers.forEach { it.join() }
            }
        }
        assertTrue(store.hmac(alias, message).hex() in expected)
    }

    @Test
    fun theKeychainWhenTheProcessHasOne() = runTest {
        val keychain = KeychainBleKeys(service = "app.conferencecaddie.ble.test")
        try {
            keychain.delete(alias)
        } catch (e: KeychainException) {
            if (e.status in NO_KEYCHAIN) {
                println("SKIPPED: the Keychain is not available to the test process (${e.status}).")
                return@runTest
            }
            throw e
        }
        try {
            val keychainStore = IosBleKeyStore(keychain)
            keychainStore.put(alias, key("key-a"))
            val message = BleProtocol.tokenMessage(2990520)
            assertContentEquals(HmacSha256.mac(key("key-a"), message), IosBleKeyStore(KeychainBleKeys("app.conferencecaddie.ble.test")).hmac(alias, message))
            assertNull(IosBleKeyStore(KeychainBleKeys("app.conferencecaddie.ble.other-test")).hmac(alias, message))
            keychainStore.remove(alias)
            assertNull(IosBleKeyStore(KeychainBleKeys("app.conferencecaddie.ble.test")).hmac(alias, message))
        } finally {
            keychain.delete(alias)
        }
    }

    private companion object {
        /** errSecNotAvailable and errSecMissingEntitlement. */
        val NO_KEYCHAIN = setOf(-25291, -34018)
    }
}
