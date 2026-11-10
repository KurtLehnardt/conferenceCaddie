package app.conferencecaddie.shared

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Readers for documents from other parties. They never throw: a value of the wrong type reads as
// absent, which is how the contracts' reference implementations treat it (`typeof`, `===` and
// `Number.isInteger` checks in JavaScript).

/** The object, or null when [this] is not a JSON object. */
internal fun JsonElement?.asObject(): JsonObject? = this as? JsonObject

/** The array, or null when [this] is not a JSON array. */
internal fun JsonElement?.asArray(): JsonArray? = this as? JsonArray

/** The string, or null when [this] is not a JSON string. */
internal fun JsonElement?.asString(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

/** True only for the JSON literal `true` (JavaScript's `v === true`). */
internal fun JsonElement?.isTrue(): Boolean = this is JsonPrimitive && !isString && content == "true"

/** True only for the JSON literal `false`. */
internal fun JsonElement?.isFalse(): Boolean = this is JsonPrimitive && !isString && content == "false"

/** True for a JSON boolean. */
internal fun JsonElement?.isBoolean(): Boolean = isTrue() || isFalse()

/** True for the JSON literal `null` or a missing value. */
internal fun JsonElement?.isNullOrMissing(): Boolean = this == null || this is JsonNull

/**
 * The value when [this] is a JSON number with an integral value (JavaScript's `Number.isInteger`,
 * so `600.0` and `6e2` count), clamped to the Long range; otherwise null.
 */
internal fun JsonElement?.asInteger(): Long? {
    val p = this as? JsonPrimitive ?: return null
    if (p.isString || p is JsonNull) return null
    p.content.toLongOrNull()?.let { return it }
    val d = p.content.toDoubleOrNull() ?: return null
    if (!d.isFinite() || d != kotlin.math.floor(d)) return null
    return when {
        d >= Long.MAX_VALUE.toDouble() -> Long.MAX_VALUE
        d <= Long.MIN_VALUE.toDouble() -> Long.MIN_VALUE
        else -> d.toLong()
    }
}

/** True when [this] is a JSON array whose items are all strings. */
internal fun JsonElement?.isStringArray(): Boolean = (this as? JsonArray)?.all { it.asString() != null } == true

/** The strings of a string array, or null when [this] is not one. */
internal fun JsonElement?.asStringList(): List<String>? =
    (this as? JsonArray)?.map { it.asString() ?: return null }
