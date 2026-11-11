package app.conferencecaddie.shared

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings

/** Builds the Android [PeopleServices]. */
object AndroidPeopleServices {
    /**
     * The people features' platform services on Android: the Keystore-backed [AndroidSecureStore],
     * [AndroidLocationProvider], [AndroidNotifier] with [notificationIcon] (a monochrome drawable of
     * the application) as its small icon, no native push ([NoPush]: the APK carries no Firebase, see
     * DECISIONS.md), and the app's page in the system settings.
     *
     * The permission prompts need the activity attached to [AndroidPermissions].
     */
    fun create(context: Context, notificationIcon: Int): PeopleServices {
        val app = context.applicationContext
        return PeopleServices(
            secureStore = AndroidSecureStore(app),
            location = AndroidLocationProvider(app),
            notifier = AndroidNotifier(app, notificationIcon),
            push = NoPush,
            systemSettings = AndroidSystemSettings(app),
        )
    }
}

/** Opens this app's page in the system settings, where a refused permission can be allowed. */
class AndroidSystemSettings(context: Context) : SystemSettings {
    private val app = context.applicationContext

    override fun openAppSettings() {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", app.packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            app.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            // A device without a settings app; there is nothing else to open.
        }
    }
}
