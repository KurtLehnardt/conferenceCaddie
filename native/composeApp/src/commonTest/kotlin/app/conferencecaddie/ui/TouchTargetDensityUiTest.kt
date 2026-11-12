package app.conferencecaddie.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.components.AppBarLabeledBack
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.CaddieIconButton
import app.conferencecaddie.ui.components.OptionRow
import app.conferencecaddie.ui.components.SwitchRow
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.people.SpotReportButton
import app.conferencecaddie.ui.people.StillChip
import app.conferencecaddie.ui.theme.CaddieTheme
import app.conferencecaddie.ui.theme.PlatformTouchTarget
import kotlin.test.Test
import kotlin.test.assertTrue

// The touch targets at densities at which their minimum is a whole number of pixels and at which it
// is not. Compose rounds a size in dp to the nearest pixel, so a minimum of 48 dp could come out up
// to half a pixel short: 36 px for 36.4 at a density of 0.758. The density a UI test draws at
// depends on the emulator's or simulator's window (TestDevice), so this test sets it itself, and
// one run on any device covers every density below. One control of each way a minimum is held:
// the control's own size (the Settings back, the spot report, the "Still in" chip), the room
// reserved around a smaller control (a button, an icon button), and a row at least 48 dp tall.
@OptIn(ExperimentalTestApi::class)
class TouchTargetDensityUiTest {
    @Test
    fun theTouchTargetsAreFullAtEveryDensity() = runComposeUiTest {
        var density by mutableStateOf(DENSITIES.first())
        setContent {
            CompositionLocalProvider(LocalDensity provides Density(density, fontScale = 1f)) {
                CaddieTheme {
                    // As wide as the test phone and as tall as it needs, whatever the window.
                    Column(Modifier.wrapContentSize(Alignment.TopStart, unbounded = true).requiredWidth(390.dp)) {
                        AppBarLabeledBack("Settings", "Back to Settings", {})
                        SpotReportButton {}
                        StillChip("Registration", active = false, enabled = true) {}
                        // Drawn 44 dp tall in the room they reserve, which is their touch target.
                        Box(Modifier.testTag("button")) { CaddieButton("Save", {}) }
                        Box(Modifier.testTag("icon-button")) { CaddieIconButton(LucideIcon.ArrowLeft, "Back", {}) }
                        SwitchRow("Notifications", checked = false, onChange = {}, modifier = Modifier.testTag("switch-row"))
                        OptionRow("Newest first", selected = false, onClick = {}, modifier = Modifier.testTag("option-row"))
                    }
                }
            }
        }

        val short = ArrayList<String>()
        fun check(name: String, node: SemanticsNodeInteraction, minWidth: Dp? = PlatformTouchTarget, minHeight: Dp = PlatformTouchTarget) {
            node.touchTargetShortfall(minWidth, minHeight)?.let { short += "$name: $it" }
        }
        for (d in DENSITIES) {
            density = d
            waitForIdle()
            check("Settings back", onNodeWithTag("appbar-back"))
            check("Spot report", onNodeWithTag("meet-spot-report"))
            check("Still in chip", onNodeWithText("Registration"))
            check("Button", onNodeWithTag("button"))
            check("Icon button", onNodeWithTag("icon-button"))
            // The web's rows are 48 dp tall on both platforms.
            check("Switch row", onNodeWithTag("switch-row"), minWidth = null, minHeight = 48.dp)
            check("Option row", onNodeWithTag("option-row"), minWidth = null, minHeight = 48.dp)
        }
        assertTrue(short.isEmpty(), "Touch targets under their minimum:\n" + short.joinToString("\n"))
    }

    private companion object {
        /**
         * 0.75, 1, 2.625 and 3.5 (120, 160, 420 and 560 dpi) give 48 dp and 44 pt in whole pixels or
         * halves, which round up. 640/844 (what TestDevice draws at in a window of 320 by 640 dp, a
         * default AVD drawing edge to edge), 1.33125 (213 dpi), 2.55 (408 dpi) and 2.9625 (474 dpi)
         * do not; at all but 1.33125, rounding to the nearest pixel falls short.
         */
        val DENSITIES = listOf(0.75f, 640f / 844f, 1f, 1.33125f, 2.55f, 2.625f, 2.9625f, 3.5f)
    }
}
