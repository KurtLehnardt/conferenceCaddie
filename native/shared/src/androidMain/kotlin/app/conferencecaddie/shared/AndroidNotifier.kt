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
import android.util.AtomicFile
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * [Notifier] on Android's own notification APIs. Notifications go to one channel, "Nudges" (the
 * web's word for them), and a tap opens the app's launcher activity with the deep link as the extra
 * [EXTRA_DEEP_LINK]; the activity hands it to [NotificationTaps] (see [tappedDeepLink]).
 *
 * The launcher activity is exported, so any installed app can start it with any extras. A tap's
 * intent therefore also carries [EXTRA_TAP_KEY], a random key made once per install and kept in the
 * app's private no-backup storage ([NotificationTapKey]). Only the app's own PendingIntents carry
 * it, and another app cannot read it from them, so a link without the key is not a tap.
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
        val intent = tapIntent(id, deepLink) ?: return
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

    /**
     * The intent a tap on notification [id] starts, which [show] wraps in the notification's
     * PendingIntent: the launcher activity, with [deepLink] and the tap key when there is a link.
     * When the key cannot be stored the link is left out, so the tap only opens the app. Null when
     * the app has no launcher activity. Public for the instrumented tests, which start the activity
     * with it as a tap would.
     */
    fun tapIntent(id: String, deepLink: String?): Intent? {
        val activity = app.packageManager.getLaunchIntentForPackage(app.packageName)?.component ?: return null
        // CLEAR_TOP with SINGLE_TOP hands the tap to the running activity through onNewIntent
        // instead of only bringing its task to the front.
        val intent = Intent()
            .setComponent(activity)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (deepLink != null) {
            NotificationTapKey.get(app, create = true)?.let { key ->
                intent.putExtra(EXTRA_DEEP_LINK, deepLink).putExtra(EXTRA_TAP_KEY, key)
            }
        }
        // Each notification gets its own PendingIntent, so replacing one never changes another's link.
        if (Build.VERSION.SDK_INT >= 29) intent.identifier = "notification:$id"
        return intent
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

        /** The intent extra that carries the tap key ([NotificationTapKey]) next to [EXTRA_DEEP_LINK]. */
        const val EXTRA_TAP_KEY = "app.conferencecaddie.notification.TAP_KEY"

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
         * [intent], or null. It is one only when the link is one of the app's own notification
         * links ([isNotificationDeepLink]) and the intent carries this install's tap key, which
         * only the app's own PendingIntents do. An intent replayed from Recents is not a new tap.
         * The key is read from storage only for an intent that carries a link, so an ordinary
         * launch reads nothing.
         */
        fun tappedDeepLink(context: Context, intent: Intent?): String? {
            if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return null
            val link: String?
            val key: String?
            try {
                link = intent.getStringExtra(EXTRA_DEEP_LINK)
                key = intent.getStringExtra(EXTRA_TAP_KEY)
            } catch (e: RuntimeException) {
                // Another app's intent may carry extras that cannot be unparcelled; that is no tap.
                return null
            }
            if (link == null || !isNotificationDeepLink(link)) return null
            return link.takeIf { NotificationTapKey.matches(context, key) }
        }
    }
}

/**
 * The per-install key that marks a notification tap as the app's own: 32 random bytes from
 * [secureRandomBytes] as 64 hex digits, made when the first notification with a link is shown and
 * kept in [Context.getNoBackupFilesDir], which no backup or device transfer copies and no other
 * app can read. A key that is missing or unreadable is made again, so a notification shown before
 * that no longer opens its link, but the app still opens.
 */
internal object NotificationTapKey {
    private const val FILE_NAME = "notification-tap-key"
    private const val KEY_BYTES = 32
    private val SHAPE = Regex("[0-9a-f]{${KEY_BYTES * 2}}")

    @Volatile
    private var cached: String? = null

    /** The key, or null when there is none; with [create], one is made and stored if there is none. */
    fun get(context: Context, create: Boolean): String? {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            val file = AtomicFile(File(context.noBackupFilesDir, FILE_NAME))
            val stored = try {
                file.readFully().decodeToString().takeIf { SHAPE.matches(it) }
            } catch (e: IOException) {
                null
            }
            if (stored != null || !create) return stored.also { cached = it }
            val fresh = secureRandomBytes(KEY_BYTES).joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
            val out = try {
                file.startWrite()
            } catch (e: IOException) {
                return null
            }
            try {
                out.write(fresh.encodeToByteArray())
                file.finishWrite(out)
            } catch (e: IOException) {
                file.failWrite(out)
                return null
            }
            cached = fresh
            return fresh
        }
    }

    /** Whether [given] is this install's key, compared in constant time. False when there is no key. */
    fun matches(context: Context, given: String?): Boolean {
        if (given == null) return false
        val key = get(context, create = false) ?: return false
        return MessageDigest.isEqual(key.encodeToByteArray(), given.encodeToByteArray())
    }
}
