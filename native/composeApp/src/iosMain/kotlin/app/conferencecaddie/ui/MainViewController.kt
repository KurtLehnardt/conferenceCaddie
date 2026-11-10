package app.conferencecaddie.ui

import androidx.compose.ui.uikit.OnFocusBehavior
import androidx.compose.ui.window.ComposeUIViewController
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.StandaloneShell
import app.conferencecaddie.ui.theme.HostController
import kotlin.experimental.ExperimentalNativeApi
import platform.Foundation.NSProcessInfo
import platform.UIKit.UIViewController

/** Called from Swift (ContentView.swift) to host the Compose UI in SwiftUI. */
@OptIn(ExperimentalNativeApi::class)
fun MainViewController(): UIViewController {
    // Debug launch options arrive as launch arguments: -caddie.tab Search.
    val args = NSProcessInfo.processInfo.arguments.map { it.toString() }
    val launch = DebugLaunch.from { name -> args.indexOf("-$name").takeIf { it >= 0 }?.let { args.getOrNull(it + 1) } }
    return ComposeUIViewController(
        configure = {
            // The screens keep their fields above the keyboard themselves (imePadding), as on
            // Android, instead of the whole view sliding up under the status bar.
            onFocusBehavior = OnFocusBehavior.DoNothing
        },
    ) {
        // The Debug configuration links a debug framework, the Release configuration a release one.
        StandaloneShell(isDebugBuild = Platform.isDebugBinary, launch = launch)
    }.also { HostController.current = it }
}
