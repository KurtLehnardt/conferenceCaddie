package app.conferencecaddie.ui

import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import app.conferencecaddie.ui.theme.PlatformTouchTarget

/**
 * Why this node is under its minimum touch target, or null when it is not: it must be at least
 * [minWidth] wide (null skips the width) and [minHeight] tall. Its size in whole pixels is compared
 * with the minimum in pixels at the density it was laid out at, with no tolerance, so a target that
 * rounds to a pixel under the minimum is under it.
 */
fun SemanticsNodeInteraction.touchTargetShortfall(minWidth: Dp? = PlatformTouchTarget, minHeight: Dp = PlatformTouchTarget): String? {
    val node = fetchSemanticsNode()
    val density = node.layoutInfo.density
    val short = listOfNotNull(
        minWidth?.let { shortfall("width", node.size.width, it, density) },
        shortfall("height", node.size.height, minHeight, density),
    )
    return if (short.isEmpty()) null else short.joinToString("; ")
}

/** Fails when this node is under its minimum touch target (see [touchTargetShortfall]). */
fun SemanticsNodeInteraction.assertTouchTarget(minWidth: Dp? = PlatformTouchTarget, minHeight: Dp = PlatformTouchTarget) {
    touchTargetShortfall(minWidth, minHeight)?.let { throw AssertionError(it) }
}

private fun shortfall(what: String, px: Int, min: Dp, density: Density): String? {
    val minPx = with(density) { min.toPx() }
    return if (px >= minPx) null else "$what $px px (${px / density.density} dp) is under $min ($minPx px) at density ${density.density}"
}
