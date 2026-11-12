package app.conferencecaddie.ui.people

import android.app.UiAutomation
import android.content.res.Configuration
import android.os.Build
import android.os.ParcelFileDescriptor
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
import app.conferencecaddie.shared.ble.BlePermissionKind

// Android: the emulator's display is resized to the window (wm size at 480 dpi, three pixels per dp)
// before the test activity starts, its system bars are hidden, and the camera is the shell's
// screencap, so sheets, dialogs and menus (windows of their own) are in the picture. The PNGs land
// in /data/local/tmp/caddie-parity, where `adb pull` finds them after the run.
//
// The status bar is put in SystemUI's demo mode for each window: its clock reads the rig's pinned
// instant (ParitySample.pinnedHhmm, 09:00) and its icons stay put, so a shot that shows the bar does
// not show the wall clock. The bar is hidden in every window before each shot, yet it still turns up
// in some shots, part faded (seen in talk-circle and people-home at 320 dp on an API 36 emulator):
// the bars are hidden with BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE, and a window that takes focus (a
// sheet's, or the activity's own while the display settles at its new size) can bring the bar back
// until its hide has taken effect. So two runs of a state can differ by the bar, and by a sheet's
// position under it, but not by the time the bar shows.
//
// Before it changes the device, each window writes what it is about to change to RESTORE_FILE and
// puts it all back in a finally. A run killed in between leaves the file, and the next window (of
// any run) puts the device back from it before it starts.

private const val SHOT_DIR = "/data/local/tmp/caddie-parity"
private const val RESTORE_FILE = "$SHOT_DIR/.restore"

private const val DEMO = "am broadcast -a com.android.systemui.demo -e command"

/** The demo-mode commands that fix the status bar: the pinned clock, full battery and wifi, no notification icons. */
private fun demoOn(): List<String> = listOf(
    "$DEMO enter",
    "$DEMO clock -e hhmm ${ParitySample.pinnedHhmm()}",
    "$DEMO battery -e level 100 -e plugged false",
    "$DEMO network -e wifi show -e level 4 -e mobile hide",
    "$DEMO notifications -e visible false",
)

internal actual fun parityShotsRequested(): List<String>? {
    val args = InstrumentationRegistry.getArguments()
    if (args.getString("caddieParity") != "1") return null
    return args.getString("caddieParityOnly")?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()
}

/** The device settings a window changes, as they were before ("null" for a setting that was not set). */
private class DeviceSettings(val fontScale: String, val demoAllowed: String, val demoOn: String) {
    fun encode(): String = "font_scale=$fontScale\nsysui_demo_allowed=$demoAllowed\nsysui_tuner_demo_on=$demoOn\n"

    companion object {
        fun read(automation: UiAutomation) = DeviceSettings(
            fontScale = setting(automation, "system", "font_scale"),
            demoAllowed = setting(automation, "global", "sysui_demo_allowed"),
            demoOn = setting(automation, "global", "sysui_tuner_demo_on"),
        )

        fun decode(text: String): DeviceSettings? {
            val values = text.lines().filter { '=' in it }.associate { it.substringBefore('=') to it.substringAfter('=').trim() }
            return DeviceSettings(
                fontScale = values["font_scale"] ?: return null,
                demoAllowed = values["sysui_demo_allowed"] ?: return null,
                demoOn = values["sysui_tuner_demo_on"] ?: return null,
            )
        }
    }
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
    // A run that died before its finally left the device changed: put it back first.
    shellOutput(automation, "cat $RESTORE_FILE").takeIf { it.isNotBlank() }?.let(DeviceSettings::decode)?.let { restore(automation, it) }
    val saved = DeviceSettings.read(automation)
    writeRestoreFile(automation, saved)
    // The device gets its own display size, density, text size and status bar back whatever happens.
    try {
        shell(automation, "wm density ${160 * scale}")
        shell(automation, "wm size ${width}x$height")
        shell(automation, "settings put system font_scale ${window.fontScale}")
        shell(automation, "settings put global sysui_demo_allowed 1")
        // SystemUI ignores demo commands until it has seen the setting change.
        SystemClock.sleep(200)
        demoOn().forEach { shell(automation, it) }
        shoot(window, width, height, block)
    } finally {
        restore(automation, saved)
    }
}

/** Puts back [saved], each step on its own, then drops the restore file. */
private fun restore(automation: UiAutomation, saved: DeviceSettings) {
    runCatching { shell(automation, "wm size reset") }
    runCatching { shell(automation, "wm density reset") }
    runCatching { putSetting(automation, "system", "font_scale", saved.fontScale) }
    // A demo mode that was already on (someone else's screenshots) stays on.
    if (saved.demoOn != "1") runCatching { shell(automation, "$DEMO exit") }
    runCatching { putSetting(automation, "global", "sysui_demo_allowed", saved.demoAllowed) }
    runCatching { shell(automation, "rm -f $RESTORE_FILE") }
}

/** Writes [saved] to [RESTORE_FILE] through the shell (only the shell user can write there); before Android 12 there is no file, and only the finally restores. */
private fun writeRestoreFile(automation: UiAutomation, saved: DeviceSettings) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
    val (output, input) = automation.executeShellCommandRw("tee $RESTORE_FILE")
    ParcelFileDescriptor.AutoCloseOutputStream(input).use { it.write(saved.encode().encodeToByteArray()) }
    // tee echoes what it wrote and ends once its input is closed.
    ParcelFileDescriptor.AutoCloseInputStream(output).use { it.readBytes() }
}

private fun setting(automation: UiAutomation, namespace: String, key: String): String =
    shellOutput(automation, "settings get $namespace $key").trim().ifEmpty { "null" }

private fun putSetting(automation: UiAutomation, namespace: String, key: String, value: String) {
    shell(automation, if (value == "null") "settings delete $namespace $key" else "settings put $namespace $key $value")
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

/** Android 12 and newer, as the emulators the screenshots run on: "Nearby devices". */
internal actual val parityBlePermission: BlePermissionKind = BlePermissionKind.NearbyDevices
