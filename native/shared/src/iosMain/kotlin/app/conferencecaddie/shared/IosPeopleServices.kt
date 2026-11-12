package app.conferencecaddie.shared

import app.conferencecaddie.shared.ble.BlePlatform
import app.conferencecaddie.shared.ble.IosBleKeyStore
import app.conferencecaddie.shared.ble.IosBleRadio
import app.conferencecaddie.shared.ble.bleEnabledInBuild
import platform.Foundation.NSURL
import platform.UIKit.UIApplication
import platform.UIKit.UIApplicationOpenSettingsURLString

/** Builds the iOS [PeopleServices]. */
object IosPeopleServices {
    /**
     * Bluetooth proximity's radio and key store, one per process: the app's screens and a relaunch
     * for Bluetooth ([app.conferencecaddie.shared.ble.IosBle]) both call [create], and Core
     * Bluetooth restores state to one pair of managers only. Null in a build that may not run it
     * ([bleEnabledInBuild]: Release builds until the Phase 4 exit test on real phones has passed),
     * so the feature is hidden even where the backend offers it, and the restore records any
     * conference left on as off.
     */
    private val ble: BlePlatform? by lazy { if (bleEnabledInBuild()) BlePlatform(IosBleRadio.shared, IosBleKeyStore()) else null }

    /**
     * The people features' platform services on iOS: the Keychain-backed [IosSecureStore],
     * [IosLocationProvider], [IosNotifier], APNs through [IosPushRegistrar], the app's page in the
     * Settings app, and Bluetooth proximity on Core Bluetooth ([IosBleRadio], always the same one)
     * with its key in the Keychain ([IosBleKeyStore]) where the build allows it. Call it on the main thread, from the app
     * (never from tests: the push registrar and the settings link reach UIApplication when used).
     * The main thread matters: the location manager is created here, eagerly, and Core Location
     * wants it made where its callbacks are delivered.
     */
    fun create(): PeopleServices {
        val notifier = IosNotifier()
        return PeopleServices(
            secureStore = IosSecureStore(),
            location = IosLocationProvider(),
            notifier = notifier,
            push = IosPushRegistrar(notifier),
            systemSettings = IosSystemSettings,
            ble = ble,
        )
    }
}

/** Opens this app's page in the Settings app, where a refused permission can be allowed. */
object IosSystemSettings : SystemSettings {
    override fun openAppSettings() {
        val url = NSURL.URLWithString(UIApplicationOpenSettingsURLString) ?: return
        UIApplication.sharedApplication.openURL(url, options = emptyMap<Any?, Any>(), completionHandler = null)
    }
}
