package app.conferencecaddie.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import kotlinx.coroutines.delay
import platform.UIKit.UIUserInterfaceStyle
import platform.UIKit.UIViewController
import platform.UIKit.UIWindow

/**
 * The view controller that hosts the Compose UI, set by MainViewController. Tests render without
 * one, so the theme then leaves the interface style alone.
 */
internal object HostController {
    var current: UIViewController? = null
}

@Composable
internal actual fun SystemBarsAppearance(preference: ThemePreference, dark: Boolean) {
    LaunchedEffect(preference) {
        val host = HostController.current ?: return@LaunchedEffect
        // The Theme choice goes on the window, which passes it to every controller in it: SwiftUI's
        // hosting controller at the root (iosApp/ContentView.swift), which the status bar follows,
        // the Compose controller, and anything presented later. With the System choice the app
        // follows the device again.
        val style = when (preference) {
            ThemePreference.System -> UIUserInterfaceStyle.UIUserInterfaceStyleUnspecified
            ThemePreference.Light -> UIUserInterfaceStyle.UIUserInterfaceStyleLight
            ThemePreference.Dark -> UIUserInterfaceStyle.UIUserInterfaceStyleDark
        }
        // The window exists once the view is on screen, which can be a frame or two after the first
        // composition.
        var window: UIWindow? = host.viewIfLoaded?.window
        var attempts = 0
        while (window == null && attempts < WINDOW_WAIT_ATTEMPTS) {
            delay(WINDOW_WAIT_MILLIS)
            window = host.viewIfLoaded?.window
            attempts++
        }
        window?.overrideUserInterfaceStyle = style
    }
}

private const val WINDOW_WAIT_MILLIS = 16L
private const val WINDOW_WAIT_ATTEMPTS = 300
