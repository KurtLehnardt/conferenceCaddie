package app.conferencecaddie.shared

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import app.conferencecaddie.shared.ble.AndroidBleKeyStore
import app.conferencecaddie.shared.ble.AndroidBleRadio
import app.conferencecaddie.shared.ble.BlePlatform

/** Builds the Android [PeopleServices]. */
object AndroidPeopleServices {
    /**
     * The people features' platform services on Android: the Keystore-backed [AndroidSecureStore],
     * [AndroidLocationProvider], [AndroidNotifier] with [notificationIcon] (a monochrome drawable of
     * the application) as its small icon, no native push ([NoPush]: the APK carries no Firebase, see
     * DECISIONS.md), the app's page in the system settings, and Bluetooth proximity
     * ([AndroidBleRadio], the process's one radio, with the Keystore-backed [AndroidBleKeyStore])
     * when [bleEnabled] and the device has Bluetooth LE. The radio's ongoing notification uses
     * [notificationIcon] too.
     *
     * [bleEnabled] is the build's switch for native Bluetooth (the app's `CADDIE_BLE_ENABLED`: on in
     * debug builds, off in release builds until the exit test on real phones has passed). Off, there
     * is no Bluetooth platform at all: the feature is hidden even where the backend offers it, no
     * radio is created, and the runtime's restore clears any Bluetooth record it finds. Off is the
     * default, so a caller that forgets it never ships the feature.
     *
     * The permission prompts need the activity attached to [AndroidPermissions].
     */
    fun create(context: Context, notificationIcon: Int, bleEnabled: Boolean = false): PeopleServices {
        val app = context.applicationContext
        return PeopleServices(
            secureStore = AndroidSecureStore(app),
            location = AndroidLocationProvider(app),
            notifier = AndroidNotifier(app, notificationIcon),
            push = NoPush,
            systemSettings = AndroidSystemSettings(app),
            ble = if (bleEnabled && AndroidBleRadio.isSupported(app)) {
                BlePlatform(AndroidBleRadio.get(app, notificationIcon), AndroidBleKeyStore())
            } else {
                null
            },
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
