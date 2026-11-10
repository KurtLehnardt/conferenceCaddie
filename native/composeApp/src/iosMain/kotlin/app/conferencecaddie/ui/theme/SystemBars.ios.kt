package app.conferencecaddie.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import platform.UIKit.UIUserInterfaceStyle
import platform.UIKit.UIViewController

/**
 * The view controller that hosts the Compose UI, set by MainViewController. Tests render without
 * one, so the theme then leaves the interface style alone.
 */
internal object HostController {
    var current: UIViewController? = null
}

@Composable
internal actual fun SystemBarsAppearance(preference: ThemePreference, dark: Boolean) {
    SideEffect {
        // The host's interface style drives the status bar text colour. With the System choice the
        // app follows the device again.
        HostController.current?.overrideUserInterfaceStyle = when (preference) {
            ThemePreference.System -> UIUserInterfaceStyle.UIUserInterfaceStyleUnspecified
            ThemePreference.Light -> UIUserInterfaceStyle.UIUserInterfaceStyleLight
            ThemePreference.Dark -> UIUserInterfaceStyle.UIUserInterfaceStyleDark
        }
    }
}
