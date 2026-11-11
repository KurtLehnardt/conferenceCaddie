package app.conferencecaddie

import androidx.test.ext.junit.runners.AndroidJUnit4
import app.conferencecaddie.shared.ble.AndroidBleKeyStore
import app.conferencecaddie.shared.ble.BleProtocol
import java.security.KeyStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Bluetooth key store in the Android Keystore on a device or emulator, against the contract's
 * golden vectors. The common tests read the vectors from the embedded fixtures, which exist only for
 * commonTest, so the values used here are copied from contracts/fixtures/ble/golden-vectors.v1.json
 * (all fake, fixed test keys). The aliases are the test's own, so the app's keys are never touched.
 */
@RunWith(AndroidJUnit4::class)
class AndroidBleKeyStoreTest {
    private val aliasA = "caddie-ble-test-a"
    private val aliasB = "caddie-ble-test-b"

    // golden-vectors.v1.json "keys": key-a is 00 01 ... 1f, key-b is ff fe ... e0.
    private val keyA = ByteArray(32) { it.toByte() }
    private val keyB = ByteArray(32) { (0xff - it).toByte() }

    // golden-vectors.v1.json "tokens": the full HMAC-SHA256 of the token message of window w.
    private val tokensA = mapOf(
        "0" to "857f1a1bc6c00c5e828d34381afd4fd515c14ac05c98db9d38dd446fb8e30331",
        "1" to "927d621cbe27899b9c3245f30ce6ffe6039bb5a0addf7266b8b2658dab066b1f",
        "2990520" to "3a4110ed2dbfdaaa28b1951eca84da1963b43518335fa82e45df47f21406e2d7",
        "2990521" to "b54e41773a7afa611230372e8a63c6afd75036e2991922e4bc06d05befe92fc7",
        "4294967295" to "a6d23aa4824854af0f66bbded156632abd1d80fe7792a27c2e1206d33a5c6f5c",
        "4294967296" to "e3161afedad9eb597789b614072a784147762899345ba163dfed5fcdcaf42614",
        "18446744073709551615" to "e12bcbe754acbae9fe69d58679b7b71651f454e95284a9bfb4d0eab92914572f",
    )
    private val tokensB = mapOf(
        "0" to "323af083c53d26508e220457b3eb913d13285063eb05fe400dbe679cb802c324",
        "2990520" to "ed9faec68b8db2609616bc128c7dcbd63bb2d5fceae475866622c9d34614ef43",
        "18446744073709551615" to "30a24f4f3f88fcc14ca39daa92b3aaeadc4d7832ef7f07973ce07648435fd64d",
    )

    // golden-vectors.v1.json "key_derivation" cases: the derived ble_key, its key id and its tokens.
    private class Derived(val keyHex: String, val keyId: String, val tokens: Map<String, String>)

    private val derived = listOf(
        Derived(
            "05a7bd314db4520b2430496a9b12eff40c87396ebde1a3006edb751ceaf58a7a",
            "Eb2uBz7W6S8",
            mapOf(
                "0" to "0bc65e9711ae8dbdfb1c19592c3a0b78",
                "2990520" to "7c889b1e1cee938d306bac69edcc9b5f",
                "2990521" to "ef43dcb291f7c738b8d5cc1c1b2c7ee6",
            ),
        ),
        Derived(
            "8fd7537dfdbe5f07e50d21a189af8e177b6e99ff407ddae692903b5fef5a02cf",
            "nX0Z9l7-dNg",
            mapOf(
                "0" to "2571e7224799885c3ee2764a2e2eb905",
                "2990520" to "649fb8927a9ed225ffbb12e96d92759d",
                "2990521" to "cc487cd2fcf641cd7d22479a4e0ec384",
            ),
        ),
    )

    private fun hex(text: String) = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    // A window index is a decimal uint64; a Long carries the same bits.
    private fun u64(text: String): Long = text.toULong().toLong()

    private fun clean() {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        ks.deleteEntry(aliasA)
        ks.deleteEntry(aliasB)
    }

    @Before
    fun setUp() = clean()

    @After
    fun tearDown() = clean()

    @Test
    fun tokensMatchTheGoldenVectors() = runBlocking {
        val store = AndroidBleKeyStore()
        store.put(aliasA, keyA)
        store.put(aliasB, keyB)
        for ((w, mac) in tokensA) assertEquals("key-a w=$w", mac, store.hmac(aliasA, BleProtocol.tokenMessage(u64(w)))?.hex())
        for ((w, mac) in tokensB) assertEquals("key-b w=$w", mac, store.hmac(aliasB, BleProtocol.tokenMessage(u64(w)))?.hex())
        // The payload a radio advertises for window 2990520 of key-a.
        val payload = BleProtocol.encodePayload(BleProtocol.tokenOf(store.hmac(aliasA, BleProtocol.tokenMessage(2990520L))!!))
        assertEquals("013a4110ed2dbfdaaa28b1951eca84da19", payload.hex())
    }

    @Test
    fun derivedKeysGiveTheirKeyIdsAndTokens() = runBlocking {
        val store = AndroidBleKeyStore()
        for (case in derived) {
            store.put(aliasA, hex(case.keyHex))
            assertEquals(case.keyId, BleProtocol.keyIdOf(store.hmac(aliasA, BleProtocol.keyIdMessage())!!))
            for ((w, token) in case.tokens) {
                assertEquals(token, BleProtocol.tokenOf(store.hmac(aliasA, BleProtocol.tokenMessage(u64(w)))!!).hex())
            }
        }
    }

    @Test
    fun putReplacesTheKey() = runBlocking {
        val store = AndroidBleKeyStore()
        store.put(aliasA, keyA)
        store.put(aliasA, keyB)
        assertEquals(tokensB.getValue("0"), store.hmac(aliasA, BleProtocol.tokenMessage(0))?.hex())
    }

    @Test
    fun removeForgetsTheKeyAndAMissingAliasReadsAsNull() = runBlocking {
        val store = AndroidBleKeyStore()
        assertNull(store.hmac(aliasA, BleProtocol.tokenMessage(0)))
        store.put(aliasA, keyA)
        assertNotNull(store.hmac(aliasA, BleProtocol.tokenMessage(0)))
        store.remove(aliasA)
        assertNull(store.hmac(aliasA, BleProtocol.tokenMessage(0)))
        // Removing what is not there does nothing.
        store.remove(aliasA)
    }

    @Test
    fun aliasesAreIndependent() = runBlocking {
        val store = AndroidBleKeyStore()
        store.put(aliasA, keyA)
        store.put(aliasB, keyB)
        store.remove(aliasB)
        assertNull(store.hmac(aliasB, BleProtocol.tokenMessage(0)))
        assertEquals(tokensA.getValue("0"), store.hmac(aliasA, BleProtocol.tokenMessage(0))?.hex())
        // A new instance finds what another stored: the Keystore holds it, not the object.
        assertEquals(tokensA.getValue("1"), AndroidBleKeyStore().hmac(aliasA, BleProtocol.tokenMessage(1))?.hex())
    }

    @Test
    fun hmacIsSafeFromManyThreadsAtOnce() = runBlocking {
        val store = AndroidBleKeyStore()
        store.put(aliasA, keyA)
        val results = (0 until 32).map { i ->
            async(Dispatchers.Default) { store.hmac(aliasA, BleProtocol.tokenMessage((i % 2).toLong()))?.hex() }
        }.awaitAll()
        for ((i, mac) in results.withIndex()) assertEquals(tokensA.getValue("${i % 2}"), mac)
    }

    @Test
    fun theKeyIsNotExportable() = runBlocking {
        AndroidBleKeyStore().put(aliasA, keyA)
        val key = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(aliasA, null)
        assertNotNull(key)
        assertNull("the Keystore never hands out the key bytes", key.encoded)
        assertArrayEquals(hex(tokensA.getValue("0")), AndroidBleKeyStore().hmac(aliasA, BleProtocol.tokenMessage(0)))
    }

    private fun ByteArray.hex(): String = joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
}
