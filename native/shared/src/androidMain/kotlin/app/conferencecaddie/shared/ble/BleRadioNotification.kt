package app.conferencecaddie.shared.ble

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import app.conferencecaddie.shared.AndroidNotifier
import app.conferencecaddie.shared.NUDGE_NOTIFICATION_LINK
import app.conferencecaddie.shared.NotificationTapKey

/**
 * The ongoing notification of [BleRadioService], which Android requires of a foreground service and
 * which says what the phone is doing: its own low-importance channel (no sound, no badge), a Stop
 * action, and a tap that opens the people screen showing who is around. The words are the Capacitor
 * app's (web/android/app/src/main/res/values/strings.xml), except [OPEN_TO_LISTEN]. Dismissing it,
 * which Android 14 and newer allow, tells the service, which posts it again.
 */
internal object BleRadioNotification {
    const val CHANNEL_ID = "finding_people"
    const val NOTIFICATION_ID = 4101

    const val CHANNEL_NAME = "Finding people near you"
    const val CHANNEL_DESCRIPTION = "Shown while Conference Caddie looks for matching people nearby over Bluetooth."
    const val TITLE = "Conference Caddie is finding people near you"
    const val TEXT = "Your phone broadcasts a random code and listens for others. Nothing about you is sent over Bluetooth."
    const val STOP = "Stop"

    /**
     * The text instead of [TEXT] on Android 10 and 11 after the system restarted the service with the
     * app in the background, where the scan may hear nothing until the app is opened.
     */
    const val OPEN_TO_LISTEN = "Open Caddie to keep listening"

    /**
     * Where a tap on the notification leads: the people screen with who is around, the nudge's link,
     * which the activity's tap allowlist already accepts (NotificationLinks.kt).
     */
    const val DEEP_LINK = NUDGE_NOTIFICATION_LINK

    /** The web's accent blue, which tints the small icon, as AndroidNotifier does. */
    private const val ACCENT = 0xFF2457D6.toInt()

    /** Creates the channel; creating it again only updates its name and description. */
    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
                description = CHANNEL_DESCRIPTION
                setShowBadge(false)
            },
        )
    }

    /**
     * The notification, with [smallIcon] (the application's monochrome icon) in the status bar, and
     * [OPEN_TO_LISTEN] as its text when [openToListen].
     */
    fun build(context: Context, smallIcon: Int, openToListen: Boolean = false): Notification {
        ensureChannel(context)
        val stop = PendingIntent.getService(
            context,
            1,
            Intent(context, BleRadioService::class.java).setAction(BleRadioService.ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        // A broadcast to the running service only (its receiver is not exported), which posts the
        // notification again.
        val deleted = PendingIntent.getBroadcast(
            context,
            4,
            Intent(BleRadioService.ACTION_NOTIFICATION_DELETED).setPackage(context.packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val text = if (openToListen) OPEN_TO_LISTEN else TEXT
        val builder = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(smallIcon)
            .setColor(ACCENT)
            .setContentTitle(TITLE)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setDeleteIntent(deleted)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            // Nothing in it is private: it says only that the app is looking for people.
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(Notification.Action.Builder(Icon.createWithResource(context, smallIcon), STOP, stop).build())
        open(context)?.let { builder.setContentIntent(it) }
        // Shown at once rather than after Android 12's ten-second grace for foreground services, so
        // the Stop action is there from the first moment.
        if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        return builder.build()
    }

    /**
     * Opens the launcher activity with [DEEP_LINK] and the app's tap key, which the activity checks
     * before it hands the link on, like a nudge's tap (AndroidNotifier.tapIntent). When the key
     * cannot be stored the link is left out, so the tap only opens the app.
     */
    private fun open(context: Context): PendingIntent? {
        val activity = context.packageManager.getLaunchIntentForPackage(context.packageName)?.component ?: return null
        val intent = Intent()
            .setComponent(activity)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        NotificationTapKey.get(context.applicationContext, create = true)?.let { key ->
            intent.putExtra(AndroidNotifier.EXTRA_DEEP_LINK, DEEP_LINK).putExtra(AndroidNotifier.EXTRA_TAP_KEY, key)
        }
        // A PendingIntent of its own, so it never takes over a nudge's (AndroidNotifier does the same).
        if (Build.VERSION.SDK_INT >= 29) intent.identifier = "ble:finding-people"
        return PendingIntent.getActivity(context, 2, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
}
