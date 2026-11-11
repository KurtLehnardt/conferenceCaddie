package app.conferencecaddie.shared

import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import platform.UserNotifications.UNAuthorizationOptionAlert
import platform.UserNotifications.UNAuthorizationOptionSound
import platform.UserNotifications.UNMutableNotificationContent
import platform.UserNotifications.UNNotificationRequest
import platform.UserNotifications.UNNotificationSound
import platform.UserNotifications.UNUserNotificationCenter

/**
 * [Notifier] on the UserNotifications framework. A notification carries its deep link in its
 * `userInfo` under [DEEP_LINK_KEY]; for a tapped one, the app delegate (iOSApp.swift) reads the
 * link with [IosNotificationTaps] and hands it to the app's link router. Asking needs no usage
 * string on iOS.
 */
class IosNotifier : Notifier {
    private val center get() = UNUserNotificationCenter.currentNotificationCenter()

    override suspend fun requestPermission(): Boolean = suspendCancellableCoroutine { waiter ->
        // Answers at once, without a prompt, once the person has decided.
        center.requestAuthorizationWithOptions(UNAuthorizationOptionAlert or UNAuthorizationOptionSound) { granted, _ ->
            if (waiter.isActive) waiter.resume(granted)
        }
    }

    override fun show(id: String, title: String, body: String, deepLink: String?) {
        val content = UNMutableNotificationContent().apply {
            setTitle(title)
            setBody(body)
            setSound(UNNotificationSound.defaultSound)
            if (deepLink != null) setUserInfo(mapOf(DEEP_LINK_KEY to deepLink))
        }
        // No trigger: shown now. A request with the same identifier replaces the earlier one.
        center.addNotificationRequest(UNNotificationRequest.requestWithIdentifier(id, content, null), null)
    }

    override fun cancel(id: String) {
        center.removePendingNotificationRequestsWithIdentifiers(listOf(id))
        center.removeDeliveredNotificationsWithIdentifiers(listOf(id))
    }

    companion object {
        /** The userInfo key of a notification's deep link, local and remote (APNs) alike. */
        const val DEEP_LINK_KEY = "deepLink"
    }
}

/**
 * The link of a tapped notification, a local one ([IosNotifier]) or a remote one (APNs, whose
 * top-level `deepLink` arrives in the same `userInfo`). Only the app itself and the backend that
 * holds its APNs key can post either, so no other app can hand a link over this way; the link must
 * still be one of the exact links the app's notifications carry ([isNotificationDeepLink]), as on
 * Android. The app delegate (iOSApp.swift) passes a tap's `userInfo` to composeApp's
 * `openNotificationTap`, which hands the link to the app's link router like any other `caddie://`
 * link.
 */
object IosNotificationTaps {
    /** The app's own deep link in [userInfo], or null when it carries none. */
    fun deepLink(userInfo: Map<Any?, *>): String? {
        val link = userInfo[IosNotifier.DEEP_LINK_KEY] as? String ?: return null
        return link.takeIf { isNotificationDeepLink(it) }
    }
}
