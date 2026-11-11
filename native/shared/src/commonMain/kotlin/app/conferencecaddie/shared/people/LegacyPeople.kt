package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.importer.BoundedJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * What the Capacitor app (v0.3.0 and earlier, the same application id) kept in its WebView's local
 * storage for the people features (web/src/people/storage.ts), read once when the native app is
 * installed over it: the device credential under [DEVICE_KEY], as `{"profile_id": ..., "secret":
 * ...}`, and the profile under [PROFILE_KEY], whose fields the native [Profile] shares. The
 * credential matters most: without it the profile the old app made on the server is one this phone
 * can neither change nor delete, and turning visibility on would make a second one.
 *
 * Everything read is untrusted and bounded: a credential must have exactly the contract's shape
 * ([DeviceCredential.wellFormed]), a profile is read with [BoundedJson] and cut to this app's limits
 * ([Profile.sanitized]), and a value longer than [MAX_VALUE_CHARS] is refused. Nothing here logs a
 * value, and the credential is handed on only as the header [PeopleController.adoptLegacy] stores.
 */
object LegacyPeople {
    const val DEVICE_KEY = "caddie.device.v1"
    const val PROFILE_KEY = "caddie.profile.v1"
    const val MAX_VALUE_CHARS = 200_000

    /**
     * The `{profile_id}.{secret}` header of a stored [DEVICE_KEY] value, or null unless both parts
     * are strings of exactly the contract's shape.
     */
    fun credentialHeader(value: String): String? {
        if (value.length > MAX_VALUE_CHARS) return null
        val o = BoundedJson().parse(value) as? JsonObject ?: return null
        val id = o.string("profile_id") ?: return null
        val secret = o.string("secret") ?: return null
        if (!DeviceCredential.wellFormed(id, secret)) return null
        return "$id.$secret"
    }

    /**
     * The profile a stored [PROFILE_KEY] value holds, cut to this app's limits, or null when the
     * value is not a profile object. The web's own reader keeps only the string fields and the
     * topic lists it knows; so does this one, through [Profile]'s lenient decoding.
     */
    fun profile(value: String): Profile? {
        if (value.length > MAX_VALUE_CHARS) return null
        if (BoundedJson().parse(value) !is JsonObject) return null
        val p = try {
            PeopleJson.responses.decodeFromString(Profile.serializer(), value)
        } catch (e: Exception) {
            return null
        }
        return p.sanitized().takeIf { it != Profile.EMPTY }
    }

    private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
}
