package app.conferencecaddie.shared

/** A nudge: the People tab on "Around now" (ConnectRuntime's NUDGE_DEEP_LINK, and every native push). */
internal const val NUDGE_NOTIFICATION_LINK = "caddie://people?around=1"

/** Requests. */
internal const val INBOX_NOTIFICATION_LINK = "caddie://inbox"

/** Meet up, followed by the meet's id. */
internal const val MEET_NOTIFICATION_LINK_PREFIX = "caddie://meet/"

/** The longest meet id a link may carry. */
private const val MAX_MEET_ID = 128

/**
 * A meet id as the server makes them (16 random bytes in base64url, 22 characters), with room for
 * a longer id of the same alphabet.
 */
private val MEET_ID = Regex("[A-Za-z0-9_-]{1,$MAX_MEET_ID}")

/**
 * Whether [id] has the shape of a meet id: 1 to 128 characters of `A-Z`, `a-z`, `0-9`, `_` and `-`.
 * Meet links in both shapes, `caddie://meet/{id}` and the web's `#/meet/{id}` ([AppLink]), use it.
 */
internal fun isMeetId(id: String): Boolean = id.length <= MAX_MEET_ID && MEET_ID.matches(id)

/**
 * Whether a platform host hands [deepLink] from a tapped notification to the app's link router
 * ([AppLink.parse], through the app's hand-off of incoming links), and whether the router takes
 * one of these hosts at all. Only the exact links a notification of this app carries are, compared
 * character for character:
 *
 * - `caddie://people?around=1`, the nudge, both the app's own local one and the server's native
 *   push (`NATIVE_ALERT` in server/native-push.mjs);
 * - `caddie://inbox`;
 * - `caddie://meet/{meet_id}`, where the id is 1 to 128 characters of `A-Z`, `a-z`, `0-9`, `_`
 *   and `-`.
 *
 * Anything else is refused: another host or path, a further path segment, a trailing slash, any
 * other query or a fragment, another case, and percent-encoding (no allowed link contains `%`).
 * The check is a pure function of the text, so the platform hosts and the app's link router can
 * share it. It decides only which links are well formed; on Android, `AndroidNotifier` also checks
 * that the tap came from one of the app's own notifications.
 */
internal fun isNotificationDeepLink(deepLink: String): Boolean = when {
    deepLink == NUDGE_NOTIFICATION_LINK || deepLink == INBOX_NOTIFICATION_LINK -> true
    deepLink.startsWith(MEET_NOTIFICATION_LINK_PREFIX) ->
        deepLink.length <= MEET_NOTIFICATION_LINK_PREFIX.length + MAX_MEET_ID &&
            isMeetId(deepLink.substring(MEET_NOTIFICATION_LINK_PREFIX.length))
    else -> false
}
