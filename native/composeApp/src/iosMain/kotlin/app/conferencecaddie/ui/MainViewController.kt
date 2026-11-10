package app.conferencecaddie.ui

import androidx.compose.ui.window.ComposeUIViewController
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.core.IosCore
import app.conferencecaddie.ui.talks.CaddieApp
import app.conferencecaddie.ui.theme.HostController
import kotlin.experimental.ExperimentalNativeApi
import platform.Foundation.NSBundle
import platform.Foundation.NSUserDefaults
import platform.UIKit.UIViewController

/** Called from Swift (ContentView.swift) to host the Compose UI in SwiftUI. */
@OptIn(ExperimentalNativeApi::class)
fun MainViewController(): UIViewController {
    // The Debug configuration links a debug framework, the Release configuration a release one.
    val isDebugBuild = Platform.isDebugBinary
    val core = IosCore.get(allowLocalHttp = isDebugBuild)
    // Debug builds only: a backend and a search text passed as launch arguments
    // (xcrun simctl launch booted app.conferencecaddie -caddieDebugBackend https://127.0.0.1:8766
    // -caddieDebugQuery "..."), which iOS exposes through the argument domain of the user defaults.
    var debugQuery: String? = null
    if (isDebugBuild) {
        val defaults = NSUserDefaults.standardUserDefaults
        defaults.stringForKey("caddieDebugBackend")?.let { url ->
            (BackendUrl.normalise(url, allowLocalHttp = true) as? BackendUrl.Valid)?.let { core.setBackend(it) }
        }
        debugQuery = defaults.stringForKey("caddieDebugQuery")
    }
    val version = NSBundle.mainBundle.objectForInfoDictionaryKey("CFBundleShortVersionString") as? String ?: ""
    return ComposeUIViewController {
        CaddieApp(core = core, isDebugBuild = isDebugBuild, appVersion = version, initialQuery = debugQuery)
    }.also { HostController.current = it }
}
