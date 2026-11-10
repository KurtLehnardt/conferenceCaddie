package app.conferencecaddie.ui

import androidx.compose.ui.window.ComposeUIViewController
import platform.UIKit.UIViewController

/** Called from Swift (ContentView.swift) to host the Compose UI in SwiftUI. */
fun MainViewController(): UIViewController = ComposeUIViewController { App() }
