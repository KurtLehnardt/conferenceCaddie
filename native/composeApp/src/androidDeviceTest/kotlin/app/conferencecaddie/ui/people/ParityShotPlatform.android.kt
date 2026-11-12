package app.conferencecaddie.ui.people

import android.app.UiAutomation
import android.content.res.Configuration
import android.os.SystemClock
import android.view.WindowInsets
import android.view.WindowInsetsController
import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.runAndroidComposeUiTest
import androidx.test.platform.app.InstrumentationRegistry

// Android: the emulator's display is resized to the window (wm size at 480 dpi, three pixels per dp)
// before the test activity starts, its system bars are hidden, and the camera is the shell's
// screencap, so sheets, dialogs and menus (windows of their own) are in the picture. The PNGs land
// in /data/local/tmp/caddie-parity, where `adb pull` finds them after the run.
//
// A sheet's window can still show the status bar for a moment, with the device's clock in it. So
// the status bar is put in SystemUI's demo mode for the run: its clock reads 09:00, the rig's pinned
// instant (ParitySample.pinnedNowMs), and its icons stay put, so no shot shows the wall clock.

private const val SHOT_DIR = "/data/local/tmp/caddie-parity"

private const val DEMO = "am broadcast -a com.android.systemui.demo -e command"
private val DEMO_ON = listOf(
    "$DEMO enter",
    "$DEMO clock -e hhmm 0900",
    "$DEMO battery -e level 100 -e plugged false",
    "$DEMO network -e wifi show -e level 4 -e mobile hide",
    "$DEMO notifications -e visible false",
)

internal actual fun parityShotsRequested(): List<String>? {
    val args = InstrumentationRegistry.getArguments()
    if (args.getString("caddieParity") != "1") return null
    return args.getString("caddieParityOnly")?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()
}

@Suppress("DEPRECATION")
@OptIn(ExperimentalTestApi::class)
internal actual fun runParityShot(window: ParityWindow, block: ComposeUiTest.(ParityCamera) -> Unit) {
    val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
    // The emulator's display goes up to 7200 pixels a side: taller windows (Profile, Settings) are
    // shot at two pixels per dp instead.
    val scale = if (maxOf(window.widthDp, window.heightDp) * 3 > 7200) 2 else 3
    val width = window.widthDp * scale
    val height = window.heightDp * scale
    shell(automation, "mkdir -p $SHOT_DIR")
    val fontScale = shellOutput(automation, "settings get system font_scale").trim().toFloatOrNull() ?: 1f
    val demoAllowed = shellOutput(automation, "settings get global sysui_demo_allowed").trim()
    shell(automation, "wm density ${160 * scale}")
    shell(automation, "wm size ${width}x$height")
    shell(automation, "settings put system font_scale ${window.fontScale}")
    shell(automation, "settings put global sysui_demo_allowed 1")
    DEMO_ON.forEach { shell(automation, it) }
    // The device gets its own display size, density, text size and status bar back whatever happens.
    try {
        shoot(window, width, height, block)
    } finally {
        shell(automation, "wm size reset")
        shell(automation, "wm density reset")
        shell(automation, "settings put system font_scale $fontScale")
        shell(automation, "$DEMO exit")
        shell(automation, if (demoAllowed == "1") "settings put global sysui_demo_allowed 1" else "settings delete global sysui_demo_allowed")
    }
}

@Suppress("DEPRECATION")
@OptIn(ExperimentalTestApi::class)
private fun shoot(window: ParityWindow, width: Int, height: Int, block: ComposeUiTest.(ParityCamera) -> Unit) {
    val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
    runAndroidComposeUiTest<ComponentActivity> {
        val activity = checkNotNull(activity)
        activity.runOnUiThread {
            activity.window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        }
        // The display takes a moment to settle at its new size.
        waitUntil(timeoutMillis = 10_000) { activity.window.decorView.width == width && activity.window.decorView.height == height }
        block { name ->
            waitForIdle()
            // Sheets, dialogs and menus are windows of their own, which bring the system bars back
            // while they have focus: hide them there too.
            val views = onAllNodes(isRoot()).fetchSemanticsNodes().mapNotNull { (it.root as? ViewRootForTest)?.view }
            activity.runOnUiThread { views.forEach { it.windowInsetsController?.hide(WindowInsets.Type.systemBars()) } }
            waitForIdle()
            SystemClock.sleep(500)
            shell(automation, "screencap -p $SHOT_DIR/$name.png")
        }
    }
}

/** Runs [command] as the shell user and waits for it to finish. */
private fun shell(automation: UiAutomation, command: String) {
    shellOutput(automation, command)
}

/** Runs [command] as the shell user and returns what it printed. */
private fun shellOutput(automation: UiAutomation, command: String): String =
    automation.executeShellCommand(command).use { fd ->
        java.io.FileInputStream(fd.fileDescriptor).use { it.readBytes() }.decodeToString()
    }

@Composable
internal actual fun ParitySystemTheme(dark: Boolean, content: @Composable () -> Unit) {
    val base = LocalConfiguration.current
    val configuration = remember(base, dark) {
        Configuration(base).apply {
            uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                (if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)
        }
    }
    CompositionLocalProvider(LocalConfiguration provides configuration, content = content)
}
