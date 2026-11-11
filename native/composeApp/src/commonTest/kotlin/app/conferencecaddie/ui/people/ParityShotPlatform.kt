package app.conferencecaddie.ui.people

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import app.conferencecaddie.shared.ble.BlePermissionKind

// What the parity screenshots ([PeopleParityShots]) need from each platform: whether they were asked
// for, a window of a given size at three pixels per dp (the web screenshots' scale), the system's
// light or dark theme, and a camera that saves what the window shows as a PNG.

/** A window of [widthDp] x [heightDp] at three pixels per dp, with text scaled by [fontScale]. */
internal class ParityWindow(val widthDp: Int, val heightDp: Int, val fontScale: Float = 1f)

/** Saves what the window shows now as `{name}.png` in the screenshot folder. */
internal fun interface ParityCamera {
    fun shoot(name: String)
}

/**
 * The states to shoot when the parity screenshots were asked for (an empty list for all of them),
 * or null when they were not, so normal test runs skip them. Android reads the instrumentation
 * arguments `caddieParity=1` and `caddieParityOnly`; iOS the environment variables
 * `CADDIE_PARITY_DIR` and `CADDIE_PARITY_ONLY` (through `SIMCTL_CHILD_`).
 */
internal expect fun parityShotsRequested(): List<String>?

/** Runs [block] in a new window of [window]'s size, with a camera for it. */
@OptIn(ExperimentalTestApi::class)
internal expect fun runParityShot(window: ParityWindow, block: ComposeUiTest.(ParityCamera) -> Unit)

/** Draws [content] as the system's dark theme ([dark]) or light theme would. */
@Composable
internal expect fun ParitySystemTheme(dark: Boolean, content: @Composable () -> Unit)

/** The Bluetooth permission this platform's radio asks for, so the Bluetooth states show each platform's own words. */
internal expect val parityBlePermission: BlePermissionKind
