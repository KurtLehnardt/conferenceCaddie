package app.conferencecaddie.shared

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

/**
 * [Notifier] on Android's own notification APIs. Notifications go to one channel, "Nudges" (the
 * web's word for them), and a tap opens the app's launcher activity with the deep link as the extra
 * [EXTRA_DEEP_LINK]; the activity hands it to [NotificationTaps] (see [tappedDeepLink]).
 *
 * [smallIcon] is the app's monochrome status bar icon, a drawable resource of the application.
 */
class AndroidNotifier(context: Context, private val smallIcon: Int) : Notifier {
    private val app = context.applicationContext
    private val manager: NotificationManager = app.getSystemService(NotificationManager::class.java)

    override suspend fun requestPermission(): Boolean {
        ensureChannel()
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
            AndroidPermissions.request(Manifest.permission.POST_NOTIFICATIONS)
        }
        return canNotify()
    }

    override fun show(id: String, title: String, body: String, deepLink: String?) {
        ensureChannel()
        val activity = app.packageManager.getLaunchIntentForPackage(app.packageName)?.component ?: return
        // CLEAR_TOP with SINGLE_TOP hands the tap to the running activity through onNewIntent
        // instead of only bringing its task to the front.
        val intent = Intent()
            .setComponent(activity)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (deepLink != null) intent.putExtra(EXTRA_DEEP_LINK, deepLink)
        // Each notification gets its own PendingIntent, so replacing one never changes another's link.
        if (Build.VERSION.SDK_INT >= 29) intent.identifier = "notification:$id"
        val tap = PendingIntent.getActivity(
            app,
            id.hashCode(),
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = Notification.Builder(app, CHANNEL_ID)
            .setSmallIcon(smallIcon)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setCategory(Notification.CATEGORY_SOCIAL)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build()
        try {
            manager.notify(id, NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            // Notifications are not allowed; nothing is shown, as on a phone with them switched off.
        }
    }

    override fun cancel(id: String) {
        manager.cancel(id, NOTIFICATION_ID)
    }

    private fun granted(permission: String) =
        app.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun canNotify(): Boolean =
        manager.areNotificationsEnabled() &&
            manager.getNotificationChannel(CHANNEL_ID)?.importance != NotificationManager.IMPORTANCE_NONE

    /** Creates the channel; creating it again only updates its name and description. */
    private fun ensureChannel() {
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH).apply {
                description = CHANNEL_DESCRIPTION
            },
        )
    }

    companion object {
        /** The intent extra that carries a tapped notification's deep link. */
        const val EXTRA_DEEP_LINK = "app.conferencecaddie.notification.DEEP_LINK"

        const val CHANNEL_ID = "nudges"

        // The web's words: the Settings group is "Nudges", and its switch reads "Nudge me when a
        // strong match or someone I'm watching is around" (web/src/people/nudges.ts).
        private const val CHANNEL_NAME = "Nudges"
        private const val CHANNEL_DESCRIPTION = "When a strong match or someone you're watching is around"

        /** Every notification has its own tag (the id given to [show]) and this number. */
        private const val NOTIFICATION_ID = 1

        /** The web's accent blue, which tints the small icon in the notification shade. */
        private const val ACCENT = 0xFF2457D6.toInt()

        /**
         * The deep link of a tapped notification that started or reached the activity with
         * [intent], or null. An intent replayed from Recents is not a new tap.
         */
        fun tappedDeepLink(intent: Intent?): String? {
            if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return null
            return intent.getStringExtra(EXTRA_DEEP_LINK)?.takeIf(::isNotificationDeepLink)
        }
    }
}
