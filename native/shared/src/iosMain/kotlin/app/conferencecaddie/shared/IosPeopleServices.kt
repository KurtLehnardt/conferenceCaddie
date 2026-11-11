package app.conferencecaddie.shared

import platform.Foundation.NSURL
import platform.UIKit.UIApplication
import platform.UIKit.UIApplicationOpenSettingsURLString

/** Builds the iOS [PeopleServices]. */
object IosPeopleServices {
    /**
     * The people features' platform services on iOS: the Keychain-backed [IosSecureStore],
     * [IosLocationProvider], [IosNotifier], APNs through [IosPushRegistrar], and the app's page in
     * the Settings app. Call it on the main thread, from the app (never from tests: the push
     * registrar and the settings link reach UIApplication when used). The main thread matters: the
     * location manager is created here, eagerly, and Core Location wants it made where its callbacks
     * are delivered.
     */
    fun create(): PeopleServices {
        val notifier = IosNotifier()
        return PeopleServices(
            secureStore = IosSecureStore(),
            location = IosLocationProvider(),
            notifier = notifier,
            push = IosPushRegistrar(notifier),
            systemSettings = IosSystemSettings,
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
