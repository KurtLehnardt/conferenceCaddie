package app.conferencecaddie.shared

/**
 * Whether a platform host hands [deepLink] from a tapped notification to [NotificationTaps]. Only the
 * app's own `caddie://` links of a sane length are; the screens check the exact shape themselves.
 */
internal fun isNotificationDeepLink(deepLink: String): Boolean =
    deepLink.startsWith("caddie://") && deepLink.length <= 512
