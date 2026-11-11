package app.conferencecaddie.ui

import androidx.compose.ui.uikit.OnFocusBehavior
import androidx.compose.ui.window.ComposeUIViewController
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.core.IosCore
import app.conferencecaddie.shared.embed.OnnxRuntimeTelemetry
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.talks.CaddieApp
import app.conferencecaddie.ui.talks.EmbeddingModel
import app.conferencecaddie.ui.talks.TalkLaunch
import app.conferencecaddie.ui.theme.HostController
import kotlin.experimental.ExperimentalNativeApi
import platform.Foundation.NSBundle
import platform.Foundation.NSProcessInfo
import platform.UIKit.UIViewController

/** Called from Swift (ContentView.swift) to host the Compose UI in SwiftUI. */
@OptIn(ExperimentalNativeApi::class)
fun MainViewController(): UIViewController {
    // First, on the main thread, before the core or ONNX Runtime start any thread (see OnnxRuntimeTelemetry).
    OnnxRuntimeTelemetry.disableForProcess()
    // The Debug configuration links a debug framework, the Release configuration a release one.
    val isDebugBuild = Platform.isDebugBinary
    val core = IosCore.get(allowLocalHttp = isDebugBuild)
    // Debug launch options arrive as launch arguments: -caddie.tab Search. Besides the shell's
    // options, -caddie.backend points the app at a backend and -caddie.query types a search.
    // Release builds ignore them all.
    val args = NSProcessInfo.processInfo.arguments.map { it.toString() }
    val get: (String) -> String? = { name -> args.indexOf("-$name").takeIf { it >= 0 }?.let { args.getOrNull(it + 1) } }
    val launch = if (isDebugBuild) DebugLaunch.from(get) else DebugLaunch()
    var query: String? = null
    val talkLaunch = if (isDebugBuild) TalkLaunch.from(get) else TalkLaunch()
    if (isDebugBuild) {
        get("caddie.backend")?.let { url ->
            (BackendUrl.normalise(url, allowLocalHttp = true) as? BackendUrl.Valid)?.let { core.setBackend(it) }
        }
        query = get("caddie.query")
    }
    val version = NSBundle.mainBundle.objectForInfoDictionaryKey("CFBundleShortVersionString") as? String ?: ""
    return ComposeUIViewController(
        configure = {
            // The screens keep their fields above the keyboard themselves (imePadding), as on
            // Android, instead of the whole view sliding up under the status bar.
            onFocusBehavior = OnFocusBehavior.DoNothing
        },
    ) {
        CaddieApp(
            core = core,
            isDebugBuild = isDebugBuild,
            appVersion = version,
            launch = launch,
            initialQuery = query,
            talkLaunch = talkLaunch,
            embedder = { EmbeddingModel.load() },
        )
    }.also { HostController.current = it }
}
