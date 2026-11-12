package app.conferencecaddie.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.BrandBlue
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.MOTION_MS
import app.conferencecaddie.ui.theme.PlatformTouchTarget
import app.conferencecaddie.ui.theme.minimumTouchTarget
import app.conferencecaddie.ui.theme.touchTargetIn

/**
 * .appbar: [leading] (a Back button), the title, and [actions] on the right, on the page colour,
 * below the status bar and clear of the display cutout and the side navigation bar in landscape.
 * The title marks itself as a heading for screen readers ([AppBarTitle], [SwitcherButton]).
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
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
            .heightIn(min = Caddie.dimens.appBarHeight)
            .padding(start = if (leading != null) 4.dp else Caddie.dimens.gutter, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        leading?.invoke()
        Box(Modifier.weight(1f)) { title() }
        Row(verticalAlignment = Alignment.CenterVertically, content = actions)
    }
}

/** .appbar-back: the arrow Back of Settings, Requests and Meet up, named "Back". */
@Composable
fun AppBarBack(onClick: () -> Unit, modifier: Modifier = Modifier) {
    CaddieIconButton(LucideIcon.ArrowLeft, Strings.AppBar.BACK, onClick, modifier.testTag("appbar-back"), iconSize = 22.dp)
}

/**
 * .appbar-back-labeled: Profile's Back, a chevron and [label] ("Settings", or the name of the tab
 * Profile was opened from) in the accent ink at 17 sp, named [contentDescription] ("Back to
 * Settings") for screen readers.
 */
@Composable
fun AppBarLabeledBack(label: String, contentDescription: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Caddie.colors
    Row(
        modifier
            .touchTargetIn(minWidth = PlatformTouchTarget, minHeight = PlatformTouchTarget)
            .caddieClickable(Pill, onClick = onClick)
            .semantics { this.contentDescription = contentDescription }
            .testTag("appbar-back")
            .padding(start = 10.dp, end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        LucideImage(LucideIcon.ChevronLeft, null, size = 24.dp, tint = c.accentInk)
        // The button's name is the content description; the visible word is not read twice.
        Text(label, style = Caddie.type.backLabel, color = c.accentInk, maxLines = 1, modifier = Modifier.clearAndSetSemantics { })
    }
}

/** A screen title in the app bar (.appbar-title), such as "Settings", marked as a heading. */
@Composable
fun AppBarTitle(text: String) {
    Text(
        text,
        style = Caddie.type.appBarTitle,
        color = Caddie.colors.text,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.semantics { heading() },
    )
}

/**
 * .switcher-btn: the current conference's name with a chevron; it opens the conference switcher.
 * Screen readers hear the name followed by ", change conference", as a heading (the web's button
 * sits in the app bar's h1).
 */
@Composable
fun SwitcherButton(name: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier
            .offset(x = (-8).dp)
            .minimumTouchTarget()
            .heightIn(min = Caddie.dimens.minTouch)
            .caddieClickable(RoundedCornerShape(10.dp), onClick = onClick)
            .semantics {
                contentDescription = name + Strings.AppBar.CHANGE_CONFERENCE
                heading()
            }
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

/**
 * True inside the shell's wide layout (a window at least 768 dp wide, with the side rail), so
 * components can follow the web's wide rules, such as chip rows that wrap instead of scrolling.
 */
val LocalWideLayout = staticCompositionLocalOf { false }

/** True in a window narrower than 360 dp (CaddieDimens.narrowAppBarMaxWidth), where the app bar has the least room. */
val LocalNarrowLayout = staticCompositionLocalOf { false }

/** One destination of the tab bar. */
data class NavItem<T>(val id: T, val label: String, val icon: LucideIcon, val badge: Int = 0, val accessibilityLabel: String? = null)

/**
 * .nav: the bottom tab bar on the surface colour with a hairline on top. The selected tab's icon
 * sits on an accent-tinted pill, its stroke is heavier (2.25 against 1.75) and its label bolder, as
 * on the web. [selected] may be null when a pushed screen such as Settings is showing. The surface
 * reaches the screen's edges; the tabs stay clear of the navigation bar and the display cutout.
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
                .windowInsetsPadding(
                    WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)
                        .union(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom)),
                )
                .heightIn(min = d.navHeight)
                .selectableGroup()
                .semantics { isTraversalGroup = true },
        ) {
            items.forEach { item ->
                NavDestination(item, item.id == selected, { onSelect(item.id) }, Modifier.weight(1f).heightIn(min = d.navHeight))
            }
        }
    }
}

/**
 * The wide layout's side rail (.nav at min-width 768px): the web app's icon on top, then the same
 * destinations as [NavBar], each at least 64 dp tall, on the surface colour with a hairline on the right. It
 * stays clear of the status bar, the display cutout and the navigation bar, and scrolls when the
 * window is too short for all of it.
 */
@Composable
fun <T> NavRail(items: List<NavItem<T>>, selected: T?, onSelect: (T) -> Unit, modifier: Modifier = Modifier) {
    val c = Caddie.colors
    val d = Caddie.dimens
    Row(modifier.fillMaxHeight().background(c.surface).testTag("nav-rail")) {
        Column(
            Modifier
                .fillMaxHeight()
                .windowInsetsPadding(
                    WindowInsets.safeDrawing.only(WindowInsetsSides.Start + WindowInsetsSides.Top)
                        .union(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom)),
                )
                .width(d.railWidth - 1.dp)
                // A phone in landscape can be shorter than the icon and four tabs.
                .verticalScroll(rememberScrollState())
                .padding(top = 12.dp)
                .selectableGroup()
                .semantics { isTraversalGroup = true },
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 16.dp), contentAlignment = Alignment.Center) {
                BrandMark()
            }
            items.forEach { item ->
                NavDestination(item, item.id == selected, { onSelect(item.id) }, Modifier.fillMaxWidth().heightIn(min = d.navHeight))
            }
        }
        VerticalDivider(thickness = 1.dp, color = c.border)
    }
}

/** .nav-brand: the web app's icon, a white calendar with a check on the accent blue; decorative. */
@Composable
private fun BrandMark() {
    Box(
        Modifier.clearAndSetSemantics { }.size(32.dp).background(BrandBlue, RoundedCornerShape(8.dp)),
        contentAlignment = Alignment.Center,
    ) {
        LucideImage(LucideIcon.CalendarCheck, null, size = 20.dp, tint = Color.White, strokeWidth = 2.5f)
    }
}

/** .nav-item: the icon on its pill (with the badge) and the label under it. */
@Composable
private fun <T> NavDestination(item: NavItem<T>, on: Boolean, onClick: () -> Unit, modifier: Modifier) {
    val c = Caddie.colors
    val d = Caddie.dimens
    val pill by animateColorAsState(if (on) c.accentTint else Color.Transparent, tween(MOTION_MS))
    Column(
        modifier
            .selectable(selected = on, role = Role.Tab, onClick = onClick)
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
            if (item.badge > 0) Badge(item.badge, Modifier.align(Alignment.TopStart).offset(x = 32.dp, y = (-2).dp), ring = c.surface)
        }
        NavLabel(item.label, on)
    }
}

/**
 * A tab's label on one line. It follows the system font size, but when a large size would not fit
 * the tab's width (four tabs on a 360 dp phone), it shrinks towards the default 12 sp instead of
 * wrapping a word or being cut off; below that it ends with an ellipsis.
 */
@Composable
private fun ColumnScope.NavLabel(text: String, on: Boolean) {
    val c = Caddie.colors
    val base = Caddie.type.navLabel.copy(fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium, textAlign = TextAlign.Center)
    // TextAutoSize sizes are in sp and scale with the font size setting; 12 dp written as sp is the
    // label's size at the default setting, whatever the setting is.
    val smallest = with(LocalDensity.current) { base.fontSize.value.dp.toSp() }
    val color = if (on) c.text else c.text2
    BasicText(
        text,
        style = base.copy(color = color),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        autoSize = if (smallest < base.fontSize) TextAutoSize.StepBased(minFontSize = smallest, maxFontSize = base.fontSize) else null,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 2.dp),
    )
}
