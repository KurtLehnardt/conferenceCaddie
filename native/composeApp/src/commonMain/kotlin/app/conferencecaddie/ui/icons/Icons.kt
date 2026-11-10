package app.conferencecaddie.ui.icons

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

private data class IconKey(val icon: LucideIcon, val strokeWidth: Float, val filled: Boolean)

private val cache = HashMap<IconKey, ImageVector>()

/**
 * The Compose image of a lucide icon, drawn as lucide draws it: a 24 by 24 viewBox, strokes of
 * [strokeWidth] (2 by default; the web's tab bar uses 1.75, and 2.25 for the selected tab), round
 * caps and joins. [filled] also fills the shapes, as the web fills the star of a talk marked
 * Interested. The colour comes from the `Icon` tint.
 */
fun LucideIcon.vector(strokeWidth: Float = 2f, filled: Boolean = false): ImageVector =
    cache.getOrPut(IconKey(this, strokeWidth, filled)) {
        val builder = ImageVector.Builder(
            name = "lucide.$name",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        )
        for (data in paths) {
            builder.addPath(
                pathData = addPathNodes(data),
                fill = if (filled) SolidColor(Color.Black) else null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = strokeWidth,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
        builder.build()
    }
