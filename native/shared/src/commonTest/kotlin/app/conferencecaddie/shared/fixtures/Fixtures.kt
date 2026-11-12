package app.conferencecaddie.shared.fixtures

import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/** The contract fixtures (contracts/fixtures/capabilities, bundle, embedding, people-api and ble), embedded at build time. */
@OptIn(ExperimentalEncodingApi::class)
object Fixtures {
    const val SLUG = "caddie-fixture-2099"
    const val HASH = "af85300cea6e89c95f44e71c5a2c5302ccd6cda0cdf35586e1c03cf8bc2f0cf9"
    const val BUNDLE_DIR = "bundle/$SLUG/af85300cea6e89c9"
    const val A = "$SLUG:1001"
    const val B = "$SLUG:1002"
    const val C = "$SLUG:1003"
    const val LUNCH = "$SLUG:1000"

    val names: Set<String> get() = ContractFixtureData.files.keys

    fun bytes(path: String): ByteArray {
        val chunks = ContractFixtureData.files[path] ?: error("no fixture $path")
        return Base64.decode(chunks.joinToString(""))
    }

    fun text(path: String): String = bytes(path).decodeToString()

    fun json(path: String): JsonElement = Json.parseToJsonElement(text(path))

    fun capabilities(name: String): JsonObject = json("capabilities/$name") as JsonObject

    /**
     * A capabilities fixture as an effective set writes it. The effective set always writes
     * `people.presence_keep_until`, but the contract's fixtures carry it only once the server's
     * `until: "keep"` (PR #84) lands: until then a fixture without it gets false, which is what it
     * reads as. A fixture that has it is returned as it is.
     */
    fun asWritten(capabilities: JsonObject): JsonObject {
        val people = capabilities.getValue("people").jsonObject
        if ("presence_keep_until" in people) return capabilities
        return JsonObject(capabilities + ("people" to JsonObject(people + ("presence_keep_until" to JsonPrimitive(false)))))
    }

    val index: JsonObject get() = json("bundle/conferences.json") as JsonObject

    /** The fixture conference's bundle entry in conferences.json. */
    val entry: JsonObject
        get() = (index["conferences"] as kotlinx.serialization.json.JsonArray)
            .map { it as JsonObject }
            .first { (it["slug"] as kotlinx.serialization.json.JsonPrimitive).content == SLUG }["bundle"] as JsonObject

    val files: Map<String, ByteArray>
        get() = mapOf("bundle.json" to bytes("$BUNDLE_DIR/bundle.json"), "vectors.i8" to bytes("$BUNDLE_DIR/vectors.i8"))
}
