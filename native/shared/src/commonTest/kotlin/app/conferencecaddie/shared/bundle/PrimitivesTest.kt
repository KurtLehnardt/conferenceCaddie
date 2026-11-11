package app.conferencecaddie.shared.bundle

import app.conferencecaddie.shared.fixtures.Fixtures
import app.conferencecaddie.shared.search.normalizeKey
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlinx.serialization.json.Json

class PrimitivesTest {
    @Test
    fun sha256MatchesThePublishedVectors() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Sha256.hex(ByteArray(0)))
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", Sha256.hex("abc"))
        assertEquals(
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
            Sha256.hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        )
        assertEquals("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0", Sha256.hex(ByteArray(1_000_000) { 'a'.code.toByte() }))
        // NIST's 896-bit message, whose padding spills into a third block.
        assertEquals(
            "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
            Sha256.hex(
                "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
            ),
        )
        // Zero bytes at the lengths around the 55/56/64-byte padding boundaries (Python's hashlib).
        val boundaries = mapOf(
            55 to "02779466cdec163811d078815c633f21901413081449002f24aa3e80f0b88ef7",
            56 to "d4817aa5497628e7c77e6b606107042bbba3130888c5f47a375e6179be789fbb",
            63 to "c7723fa1e0127975e49e62e753db53924c1bd84b8ac1ac08df78d09270f3d971",
            64 to "f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b",
            65 to "98ce42deef51d40269d542f5314bef2c7468d401ad5d85168bfab4c0108f75f7",
        )
        for ((n, digest) in boundaries) assertEquals(digest, Sha256.hex(ByteArray(n)), "$n zero bytes")
        assertEquals("2d779cce49b72c5b419b010f3f5ec5d0a462abd117f7aeefc99de7fd3421d405", Sha256.hex(Fixtures.files.getValue("bundle.json")))
        assertEquals("e9a59e1175adf3e679f65296842af976cc7962c0459f884e39d013ef99d5c1f5", Sha256.hex(Fixtures.files.getValue("vectors.i8")))
    }

    @Test
    fun loneSurrogatesHashAsTheReplacementCharacterOnEveryPlatform() {
        // Node and Kotlin/Native write a lone surrogate as U+FFFD (EF BF BD); the JVM would write '?'.
        // The surrogates are built from their code units, so no source literal holds a lone one.
        val hi = Char(0xD800).toString()
        val lo = Char(0xDC00).toString()
        val replacement = "83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097"
        assertEquals(replacement, Sha256.hex(hi), "a lone high surrogate")
        assertEquals(replacement, Sha256.hex(lo), "a lone low surrogate")
        assertEquals("05087813392efc16fe8ff448920c6328e53af865df39419436659d9ffda90f7b", Sha256.hex("a${hi}b"))
        assertEquals("52793f8dc1d85e409f8c88be99d8b31d58f676246340150f406289e04a11151e", Sha256.hex(lo + hi), "a reversed pair is two lone surrogates")
        assertEquals(
            "2b402c90e9b15d9c3ef65c432c4111108f54ee544cda5424db46f6ac974928e4",
            Sha256.hex(Char(0xD83D).toString() + Char(0xDD10)),
            "a valid pair is one character",
        )
        kotlin.test.assertContentEquals(byteArrayOf(0xef.toByte(), 0xbf.toByte(), 0xbd.toByte()), Sha256.utf8(hi))
        assertEquals(Sha256.hex("\uFFFD\n"), BundleVerifier.textHash(hi, ""))
    }

    @Test
    fun canonicalJsonReproducesTheFixtureBundle() {
        val text = Fixtures.files.getValue("bundle.json").decodeToString()
        assertEquals(text, CanonicalJson.encode(Json.parseToJsonElement(text)))
    }

    @Test
    fun canonicalJsonEscapesAsJsonStringifyAndRefusesFloats() {
        assertEquals("""{"a":[1,true,null],"b":"x"}""", CanonicalJson.encode(Json.parseToJsonElement("""{ "b": "x", "a": [1, true, null] }""")))
        assertEquals(""""\"\\\b\f\n\r\t\u0001\u001f é 🔐"""", CanonicalJson.encode(Json.parseToJsonElement("\"\\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u001f é 🔐\"")))
        assertEquals("\"\\ud800\"", CanonicalJson.encode(Json.parseToJsonElement("\"\\ud800\"")), "a lone surrogate is escaped")
        assertEquals("""{"B":1,"a":2,"é":3}""", CanonicalJson.encode(Json.parseToJsonElement("""{ "é": 3, "a": 2, "B": 1 }""")))
        assertEquals("100", CanonicalJson.encode(Json.parseToJsonElement("1e2")))
        assertEquals("0", CanonicalJson.encode(Json.parseToJsonElement("-0")))
        assertFailsWith<IllegalArgumentException> { CanonicalJson.encode(Json.parseToJsonElement("0.5")) }
        assertFailsWith<IllegalArgumentException> { CanonicalJson.encode(Json.parseToJsonElement("9007199254740992")) }
    }

    @Test
    fun theContentHashCoversEveryFileAndNamesTheDirectory() {
        assertEquals(Fixtures.HASH, BundleVerifier.contentHash(Fixtures.files))
        assertEquals("af85300cea6e89c9", Fixtures.HASH.substring(0, 16))
        val changed = Fixtures.files + ("vectors.i8" to Fixtures.files.getValue("vectors.i8").copyOf().also { it[0] = 0 })
        kotlin.test.assertNotEquals(Fixtures.HASH, BundleVerifier.contentHash(changed))
    }

    @Test
    fun theVectorFileIsCheckableByHand() {
        val v = Fixtures.files.getValue("vectors.i8")
        assertEquals(3 * 384, v.size)
        assertEquals(0x7f.toByte(), v[0])
        assertEquals(0x7f.toByte(), v[385])
        assertEquals(0x5f.toByte(), v[768])
        assertEquals(0x81.toByte(), v[769])
    }

    @Test
    fun isoTimes() {
        assertEquals(4_076_125_200_000L, IsoTime.epochMillis("2099-03-02T10:00:00+01:00"))
        assertEquals(IsoTime.epochMillis("2099-03-02T09:00:00Z"), IsoTime.epochMillis("2099-03-02T10:00:00+01:00"))
        assertEquals(IsoTime.epochMillis("2026-11-10T17:00:00Z"), IsoTime.epochMillis("2026-11-10T12:00:00-05:00"))
        assertEquals(1_500L, IsoTime.epochMillis("1970-01-01T00:00:01.5Z"))
        assertNull(IsoTime.epochMillis("2099-02-30T10:00:00Z"))
        assertNull(IsoTime.epochMillis("2099-03-02 10:00:00Z"))
        assertNull(IsoTime.epochMillis("2099-03-02T10:00:00"))
        assertEquals("2099-03-03", IsoTime.addDays("2099-03-02", 1))
        assertEquals("2028-03-01", IsoTime.addDays("2028-02-28", 2), "2028 is a leap year")
        assertEquals("2027-01-01", IsoTime.addDays("2026-12-31", 1))
        assertEquals(1, IsoTime.weekday("2099-03-02"), "a Monday")
        assertEquals(2, IsoTime.weekday("2026-11-10"), "a Tuesday")
        assertEquals(4, IsoTime.weekday("1970-01-01"))
    }

    @Test
    fun normalizeKeyMatchesTheServer() {
        assertEquals("security", normalizeKey("🔐 Security"))
        assertEquals("hall a room 1", normalizeKey("Hall A | Room 1"))
        assertEquals("cafe creme", normalizeKey("Café Crème"))
        assertEquals("security identity", normalizeKey("Security + Identity"))
        assertEquals("k8s 1 30", normalizeKey("  K8s 1.30!  "))
        assertEquals("", normalizeKey("--"))
    }
}
