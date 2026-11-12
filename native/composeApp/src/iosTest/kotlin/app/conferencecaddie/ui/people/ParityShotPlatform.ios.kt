package app.conferencecaddie.ui.people

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.InternalComposeUiApi
import androidx.compose.ui.LocalSystemTheme
import androidx.compose.ui.SystemTheme
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.asSkiaBitmap
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.runSkikoComposeUiTest
import androidx.compose.ui.unit.Density
import app.conferencecaddie.shared.ble.BlePermissionKind
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.toKString
import kotlinx.io.buffered
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import org.jetbrains.skia.EncodedImageFormat
import org.jetbrains.skia.Image
import platform.posix.getenv

// iOS: the test scene itself is the window, sized in pixels at a density of three, and the camera
// renders it (with its popups and dialogs, which share the scene) into a PNG in CADDIE_PARITY_DIR, a
// folder on the Mac that the simulator's processes can write to.

@OptIn(ExperimentalForeignApi::class)
private fun env(name: String): String? = getenv(name)?.toKString()?.takeIf { it.isNotBlank() }

internal actual fun parityShotsRequested(): List<String>? {
    env("CADDIE_PARITY_DIR") ?: return null
    return env("CADDIE_PARITY_ONLY")?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()
}

@OptIn(ExperimentalTestApi::class)
internal actual fun runParityShot(window: ParityWindow, block: ComposeUiTest.(ParityCamera) -> Unit) {
    val dir = checkNotNull(env("CADDIE_PARITY_DIR")) { "CADDIE_PARITY_DIR is not set" }
    @Suppress("DEPRECATION")
    runSkikoComposeUiTest(Size(window.widthDp * 3f, window.heightDp * 3f), Density(3f, window.fontScale)) {
        block { name ->
            waitForIdle()
            val image = onAllNodes(isRoot()).onFirst().captureToImage()
            val png = Image.makeFromBitmap(image.asSkiaBitmap()).encodeToData(EncodedImageFormat.PNG)
            checkNotNull(png) { "PNG encoding failed for $name" }
            SystemFileSystem.sink(Path(dir, "$name.png")).buffered().use { it.write(png.bytes) }
        }
    }
}

// LocalSystemTheme is the only way to set the system theme of a test scene on iOS.
@Suppress("DEPRECATION")
@OptIn(InternalComposeUiApi::class)
@Composable
internal actual fun ParitySystemTheme(dark: Boolean, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalSystemTheme provides if (dark) SystemTheme.Dark else SystemTheme.Light, content = content)
}

/** iOS asks for Bluetooth. */
internal actual val parityBlePermission: BlePermissionKind = BlePermissionKind.Bluetooth
