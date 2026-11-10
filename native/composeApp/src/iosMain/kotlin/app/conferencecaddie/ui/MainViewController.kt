package app.conferencecaddie.ui

import androidx.compose.ui.window.ComposeUIViewController
import app.conferencecaddie.ui.shell.StandaloneShell
import app.conferencecaddie.ui.theme.HostController
import kotlin.experimental.ExperimentalNativeApi
import platform.UIKit.UIViewController

/** Called from Swift (ContentView.swift) to host the Compose UI in SwiftUI. */
@OptIn(ExperimentalNativeApi::class)
fun MainViewController(): UIViewController = ComposeUIViewController {
    // The Debug configuration links a debug framework, the Release configuration a release one.
    StandaloneShell(isDebugBuild = Platform.isDebugBinary)
}.also { HostController.current = it }
