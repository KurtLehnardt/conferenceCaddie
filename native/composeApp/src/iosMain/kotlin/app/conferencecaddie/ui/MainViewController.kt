package app.conferencecaddie.ui

import androidx.compose.ui.window.ComposeUIViewController
import kotlin.experimental.ExperimentalNativeApi
import platform.UIKit.UIViewController

/** Called from Swift (ContentView.swift) to host the Compose UI in SwiftUI. */
@OptIn(ExperimentalNativeApi::class)
fun MainViewController(): UIViewController = ComposeUIViewController {
    // The Debug configuration links a debug framework, the Release configuration a release one.
    App(isDebugBuild = Platform.isDebugBinary)
}
