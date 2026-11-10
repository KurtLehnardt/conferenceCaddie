package app.conferencecaddie.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.DpSize

/**
 * Draws [content] as a device of [size] with the system font size set to [fontScale] would. When the
 * test window is smaller than [size], the pixel density is lowered so the whole device fits, which
 * keeps every size in dp. This is what Compose's DeviceConfigurationOverride does on Android;
 * Compose Multiplatform does not support it on iOS, so the tests use this on both.
 *
 * The device has no system bars or cutout: the insets of the real test window (which differ from one
 * emulator to the next, and would grow with the lowered density) are consumed, so sizes in a test do
 * not depend on the machine. The screenshots in the pull requests show the insets on real devices.
 */
@Composable
fun TestDevice(size: DpSize, fontScale: Float = 1f, content: @Composable () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val current = LocalDensity.current.density
        val fit = minOf(current, constraints.maxWidth / size.width.value, constraints.maxHeight / size.height.value)
        CompositionLocalProvider(LocalDensity provides Density(fit, fontScale)) {
            Box(Modifier.requiredSize(size).consumeWindowInsets(WindowInsets.safeDrawing)) { content() }
        }
    }
}
