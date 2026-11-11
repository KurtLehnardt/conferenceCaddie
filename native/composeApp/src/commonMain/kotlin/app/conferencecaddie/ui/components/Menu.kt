package app.conferencecaddie.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.theme.Caddie

/** One entry of an [OverflowMenu] (web MenuItem). */
data class MenuItem(
    val label: String,
    val onSelect: () -> Unit,
    val destructive: Boolean = false,
    val enabled: Boolean = true,
    val testTag: String? = null,
)

/**
 * The web's OverflowMenu (web/src/components/common.tsx): a vertical-dots icon button in the app bar,
 * named [label], that opens a small menu anchored to its right (.menu and .menu-item: a raised card
 * at least 200 dp wide with 44 dp rows, the destructive ones in the danger colour). Choosing an item
 * closes the menu first, as the web's does. [startOpen] opens it at once (a debug launch option, for
 * screenshots).
 */
@Composable
fun OverflowMenu(items: List<MenuItem>, label: String, modifier: Modifier = Modifier, startOpen: Boolean = false) {
    var open by rememberSaveable { mutableStateOf(startOpen) }
    val c = Caddie.colors
    Box(modifier) {
        CaddieIconButton(LucideIcon.EllipsisVertical, label, { open = !open }, iconSize = 22.dp, modifier = Modifier.testTag("overflow-menu"))
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            offset = DpOffset((-8).dp, 4.dp),
            shape = RoundedCornerShape(Caddie.dimens.radius),
            containerColor = c.surfaceRaised,
            tonalElevation = 0.dp,
            shadowElevation = 8.dp,
            border = BorderStroke(1.dp, c.border),
        ) {
            Column(Modifier.widthIn(min = 200.dp).padding(horizontal = 6.dp)) {
                items.forEach { item ->
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = Caddie.dimens.minTouch)
                            .alpha(if (item.enabled) 1f else 0.45f)
                            .caddieClickable(RoundedCornerShape(8.dp), role = Role.Button, enabled = item.enabled) {
                                open = false
                                item.onSelect()
                            }
                            .then(if (item.testTag != null) Modifier.testTag(item.testTag) else Modifier)
                            .padding(horizontal = 12.dp),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        Text(
                            item.label,
                            style = Caddie.type.toast,
                            color = if (item.destructive) c.danger else c.text,
                        )
                    }
                }
            }
        }
    }
}
