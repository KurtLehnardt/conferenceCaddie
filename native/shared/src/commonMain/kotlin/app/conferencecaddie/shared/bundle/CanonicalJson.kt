package app.conferencecaddie.shared.bundle

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Canonical JSON as the talk bundle defines it (docs/contracts/talk-bundle.md, Canonical JSON;
 * reference `canonicalJson()` in contracts/js/canonical-json.mjs): RFC 8785 restricted to objects,
 * arrays, strings, booleans, null and safe integers. Keys are sorted by UTF-16 code units, which is
 * how Kotlin compares strings, there is no whitespace, and strings are escaped as JavaScript's
 * `JSON.stringify` escapes them. A number that is not a safe integer is refused with
 * [IllegalArgumentException], as the reference refuses it.
 */
object CanonicalJson {
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    fun encode(element: JsonElement): String = StringBuilder().also { write(element, it) }.toString()

    private fun write(element: JsonElement, out: StringBuilder) {
        when (element) {
            is JsonNull -> out.append("null")
            is JsonObject -> {
                out.append('{')
                element.keys.sorted().forEachIndexed { i, key ->
                    if (i > 0) out.append(',')
                    writeString(key, out)
                    out.append(':')
                    write(element.getValue(key), out)
                }
                out.append('}')
            }
            is JsonArray -> {
                out.append('[')
                element.forEachIndexed { i, item ->
                    if (i > 0) out.append(',')
                    write(item, out)
                }
                out.append(']')
            }
            is JsonPrimitive -> when {
                element.isString -> writeString(element.content, out)
                element.content == "true" || element.content == "false" -> out.append(element.content)
                else -> out.append(safeInteger(element.content))
            }
        }
    }

    /**
     * The decimal form JavaScript gives a number that JSON.parse read from [text], when that number
     * is a safe integer ("1e2" is 100, "-0" is 0); anything else is refused.
     */
    private fun safeInteger(text: String): String {
        text.toLongOrNull()?.let { value ->
            require(value in -MAX_SAFE_INTEGER..MAX_SAFE_INTEGER) { "canonical JSON holds only safe integers" }
            return value.toString()
        }
        val value = text.toDoubleOrNull()
        require(value != null && value.isFinite() && value == kotlin.math.floor(value) &&
            kotlin.math.abs(value) <= MAX_SAFE_INTEGER.toDouble()) { "canonical JSON holds only safe integers" }
        return value.toLong().toString()
    }

    /** Escapes [text] exactly as JSON.stringify does, lone surrogates included. */
    internal fun writeString(text: String, out: StringBuilder) {
        out.append('"')
        var i = 0
        while (i < text.length) {
            val c = text[i]
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\b' -> out.append("\\b")
                c == '\u000C' -> out.append("\\f")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c < ' ' -> out.append("\\u00").append(HEX[c.code shr 4]).append(HEX[c.code and 0xf])
                c.isHighSurrogate() && i + 1 < text.length && text[i + 1].isLowSurrogate() -> {
                    out.append(c).append(text[i + 1])
                    i++
                }
                c.isSurrogate() -> out.append("\\u").append(c.code.toString(16).padStart(4, '0'))
                else -> out.append(c)
            }
            i++
        }
        out.append('"')
    }

    private const val HEX = "0123456789abcdef"
}
