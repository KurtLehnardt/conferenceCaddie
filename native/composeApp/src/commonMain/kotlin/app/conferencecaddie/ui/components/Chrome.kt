package app.conferencecaddie.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.MOTION_MS

/**
 * .appbar: [leading] (a Back button), the title, and [actions] on the right, on the page colour,
 * below the status bar. [title] is a heading for screen readers.
 */
@Composable
fun AppBar(
    title: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    leading: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier
            .fillMaxWidth()
            .background(Caddie.colors.bg)
            .windowInsetsPadding(WindowInsets.statusBars)
            .heightIn(min = Caddie.dimens.appBarHeight)
            .padding(start = if (leading != null) 4.dp else Caddie.dimens.gutter, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        leading?.invoke()
        Box(Modifier.weight(1f).semantics { heading() }) { title() }
        Row(verticalAlignment = Alignment.CenterVertically, content = actions)
    }
}

/** A screen title in the app bar (.appbar-title), such as "Settings". */
@Composable
fun AppBarTitle(text: String) {
    Text(text, style = Caddie.type.appBarTitle, color = Caddie.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/**
 * .switcher-btn: the current conference's name with a chevron; it opens the conference switcher.
 * Screen readers hear the name followed by ", change conference".
 */
@Composable
fun SwitcherButton(name: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier
            .offset(x = (-8).dp)
            .heightIn(min = Caddie.dimens.minTouch)
            .caddieClickable(RoundedCornerShape(10.dp), onClick = onClick)
            .semantics { contentDescription = name + Strings.AppBar.CHANGE_CONFERENCE }
            .testTag("conference-switcher")
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            name,
            style = Caddie.type.switcher,
            color = Caddie.colors.text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        LucideImage(LucideIcon.ChevronDown, null, size = 20.dp)
    }
}

/** One destination of the tab bar. */
data class NavItem<T>(val id: T, val label: String, val icon: LucideIcon, val badge: Int = 0, val accessibilityLabel: String? = null)

/**
 * .nav: the bottom tab bar on the surface colour with a hairline on top. The selected tab's icon
 * sits on an accent-tinted pill, its stroke is heavier (2.25 against 1.75) and its label bolder, as
 * on the web. [selected] may be null when a pushed screen such as Settings is showing.
 */
@Composable
fun <T> NavBar(items: List<NavItem<T>>, selected: T?, onSelect: (T) -> Unit, modifier: Modifier = Modifier) {
    val c = Caddie.colors
    val d = Caddie.dimens
    Column(modifier.fillMaxWidth().background(c.surface)) {
        Hairline()
        Row(
            Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.navigationBars)
                .heightIn(min = d.navHeight)
                .selectableGroup()
                .semantics { contentDescription = Strings.Tabs.NAV_LABEL },
        ) {
            items.forEach { item ->
                val on = item.id == selected
                val pill by animateColorAsState(if (on) c.accentTint else Color.Transparent, tween(MOTION_MS))
                Column(
                    Modifier
                        .weight(1f)
                        .heightIn(min = d.navHeight)
                        .selectable(selected = on, role = Role.Tab, onClick = { onSelect(item.id) })
                        .testTag("tab-${item.label}")
                        .then(if (item.accessibilityLabel != null) Modifier.semantics { contentDescription = item.accessibilityLabel } else Modifier),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
                ) {
                    Box(
                        Modifier.size(width = d.navPillWidth, height = d.navPillHeight).background(pill, RoundedCornerShape(percent = 50)),
                        contentAlignment = Alignment.Center,
                    ) {
                        LucideImage(item.icon, null, size = 24.dp, tint = if (on) c.accentInk else c.text2, strokeWidth = if (on) 2.25f else 1.75f)
                        if (item.badge > 0) Badge(item.badge, Modifier.align(Alignment.TopStart).offset(x = 32.dp, y = (-2).dp))
                    }
                    Text(
                        item.label,
                        style = Caddie.type.navLabel.copy(fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium),
                        color = if (on) c.text else c.text2,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}
