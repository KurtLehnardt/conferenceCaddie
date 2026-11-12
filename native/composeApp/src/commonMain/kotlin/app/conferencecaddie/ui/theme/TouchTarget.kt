package app.conferencecaddie.ui.theme

import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Measurable
import androidx.compose.ui.layout.MeasureResult
import androidx.compose.ui.layout.MeasureScope
import androidx.compose.ui.node.CompositionLocalConsumerModifierNode
import androidx.compose.ui.node.LayoutModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.currentValueOf
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isSpecified
import kotlin.math.ceil
import kotlin.math.roundToInt

// Touch targets that are never smaller than their minimum.
//
// Compose lays out in whole pixels and rounds a size in dp to the nearest one, so a minimum held
// with defaultMinSize, heightIn or Material's minimumInteractiveComponentSize() comes out up to
// half a pixel short at a density at which it is not a whole number of pixels: 48 dp is 122.4 px at
// 2.55 (408 dpi) and became 122 px, 47.84 dp. These modifiers round the minimum up instead.

/** [size] in whole pixels, rounded up, so that it is never under [size]. */
internal fun Density.roundUpToPx(size: Dp): Int = ceil(size.toPx()).toInt()

/**
 * Material's minimumInteractiveComponentSize() with the minimum rounded up to whole pixels: reserves
 * at least the minimum interactive size ([CaddieTheme] sets it to [PlatformTouchTarget]) in both
 * directions around a control that is drawn smaller, and centers the control in it. Compose widens
 * the tap area of a control smaller than the platform's minimum into that room.
 */
fun Modifier.minimumTouchTarget(): Modifier = this then MinimumTouchTargetElement

/**
 * At least [minWidth] wide and [minHeight] tall, as widthIn(min = ...) and heightIn(min = ...) do,
 * with each minimum rounded up to whole pixels: for a control whose own bounds are its tap area.
 * An unspecified minimum leaves that direction alone.
 */
fun Modifier.touchTargetIn(minWidth: Dp = Dp.Unspecified, minHeight: Dp = Dp.Unspecified): Modifier =
    this then TouchTargetInElement(minWidth, minHeight)

private object MinimumTouchTargetElement : ModifierNodeElement<MinimumTouchTargetNode>() {
    override fun create() = MinimumTouchTargetNode()

    override fun update(node: MinimumTouchTargetNode) = Unit

    override fun equals(other: Any?): Boolean = other === this

    override fun hashCode(): Int = "minimumTouchTarget".hashCode()
}

private class MinimumTouchTargetNode : Modifier.Node(), CompositionLocalConsumerModifierNode, LayoutModifierNode {
    override fun MeasureScope.measure(measurable: Measurable, constraints: Constraints): MeasureResult {
        val size = currentValueOf(LocalMinimumInteractiveComponentSize)
        val placeable = measurable.measure(constraints)
        val min = if (size.isSpecified && size > 0.dp) roundUpToPx(size) else 0
        val width = maxOf(placeable.width, min)
        val height = maxOf(placeable.height, min)
        return layout(width, height) {
            placeable.place(((width - placeable.width) / 2f).roundToInt(), ((height - placeable.height) / 2f).roundToInt())
        }
    }
}

private data class TouchTargetInElement(val minWidth: Dp, val minHeight: Dp) : ModifierNodeElement<TouchTargetInNode>() {
    override fun create() = TouchTargetInNode(minWidth, minHeight)

    override fun update(node: TouchTargetInNode) {
        node.minWidth = minWidth
        node.minHeight = minHeight
    }
}

private class TouchTargetInNode(var minWidth: Dp, var minHeight: Dp) : Modifier.Node(), LayoutModifierNode {
    override fun MeasureScope.measure(measurable: Measurable, constraints: Constraints): MeasureResult {
        // As heightIn(min = ...): the minimum is kept within the incoming constraints.
        val minW = if (minWidth.isSpecified) roundUpToPx(minWidth).coerceIn(constraints.minWidth, constraints.maxWidth) else constraints.minWidth
        val minH = if (minHeight.isSpecified) roundUpToPx(minHeight).coerceIn(constraints.minHeight, constraints.maxHeight) else constraints.minHeight
        val placeable = measurable.measure(constraints.copy(minWidth = minW, minHeight = minH))
        return layout(placeable.width, placeable.height) { placeable.place(0, 0) }
    }
}
