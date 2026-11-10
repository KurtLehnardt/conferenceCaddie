package app.conferencecaddie.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie

/** How a chip behaves when tapped. */
enum class ChipKind {
    /** Turns a filter on or off; shows a check while on (aria-pressed on the web). */
    Toggle,

    /** Opens a choice (the filter sheet); shows a chevron while off and a clear button while on. */
    Dropdown,

    /** Applies a suggestion or performs an action; never shows as on. */
    Action,
}

/**
 * .chip: a 36 dp pill. Off, it has a strong border on the surface colour; on, it fills with the
 * accent tint and drops the border, as on the web. [onClear] adds the separate clear button (×) an
 * active chip has, named [clearLabel] for screen readers. [leadingIcon] replaces the check of a
 * toggle chip (the Filters and Happening now chips have their own icons). [disabled] is the dashed,
 * faded look of an unavailable chip.
 */
@Composable
fun CaddieChip(
    label: String,
    active: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: ChipKind = ChipKind.Toggle,
    leadingIcon: LucideIcon? = null,
    onClear: (() -> Unit)? = null,
    clearLabel: String? = null,
    badge: Int = 0,
    disabled: Boolean = false,
    accessibilityLabel: String? = null,
) {
    val c = Caddie.colors
    val shape = Pill
    Row(
        modifier
            .heightIn(min = Caddie.dimens.minTouch)
            .padding(vertical = 4.dp)
            .height(Caddie.dimens.chipHeight)
            .alpha(if (disabled && !active) 0.65f else 1f)
            .background(if (active) c.accentTint else c.surface, shape)
            .then(if (active) Modifier else Modifier.border(1.dp, c.borderStrong, shape)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val main = Modifier
            .fillMaxHeight()
            .let { m ->
                if (kind == ChipKind.Toggle) {
                    m.focusRingToggle(active, disabled, onClick)
                } else {
                    m.caddieClickable(shape, onClick = onClick)
                }
            }
            .semantics {
                if (accessibilityLabel != null) contentDescription = accessibilityLabel
                if (disabled && !active) this.disabled()
            }
            .padding(start = 14.dp, end = if (active && onClear != null) 2.dp else 14.dp)
        Row(main, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            val fg = when {
                active -> c.accentInk
                disabled -> c.text2
                else -> c.text
            }
            when {
                leadingIcon != null -> LucideImage(if (kind == ChipKind.Toggle && active) LucideIcon.Check else leadingIcon, null, size = 16.dp, tint = fg)
                kind == ChipKind.Toggle && active -> LucideImage(LucideIcon.Check, null, size = 16.dp, tint = fg)
            }
            Text(label, style = Caddie.type.chip, color = fg, maxLines = 1)
            if (badge > 0) Badge(badge, Modifier.padding(start = 2.dp))
            if (kind == ChipKind.Dropdown && !active) LucideImage(LucideIcon.ChevronDown, null, size = 16.dp, tint = fg)
        }
        if (active && onClear != null) {
            Box(
                Modifier
                    .fillMaxHeight()
                    .caddieClickable(shape, onClick = onClear)
                    .semantics { contentDescription = clearLabel ?: Strings.Common.CLOSE }
                    .padding(start = 6.dp, end = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                LucideImage(LucideIcon.X, null, size = 16.dp, tint = c.accentInk)
            }
        }
    }
}

@Composable
private fun Modifier.focusRingToggle(active: Boolean, disabled: Boolean, onClick: () -> Unit): Modifier {
    val interaction = remember { MutableInteractionSource() }
    return this
        .focusRing(interaction, Pill)
        .clip(Pill)
        .toggleable(
            value = active,
            interactionSource = interaction,
            indication = ripple(),
            enabled = !disabled || active,
            role = Role.Switch,
            onValueChange = { onClick() },
        )
}

/** The Filters chip: the sliders icon, the label and the number of active filters. */
@Composable
fun FiltersChip(activeCount: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    CaddieChip(
        label = Strings.Chips.FILTERS,
        active = activeCount > 0,
        onClick = onClick,
        modifier = modifier,
        kind = ChipKind.Action,
        leadingIcon = LucideIcon.SlidersHorizontal,
        badge = activeCount,
        accessibilityLabel = if (activeCount > 0) Strings.Chips.filtersActive(activeCount) else Strings.Chips.FILTERS,
    )
}

/** A time phrase taken out of the search text, shown on and removable ("Tuesday · Tue, Nov 10" ×). */
@Composable
fun TimePhraseChip(label: String, singleDay: String?, onRemove: () -> Unit, modifier: Modifier = Modifier) {
    CaddieChip(
        label = Strings.Chips.timePhrase(label, singleDay),
        active = true,
        onClick = onRemove,
        modifier = modifier,
        kind = ChipKind.Action,
        // An applied phrase looks like any other active filter: a check, the label and a clear button.
        leadingIcon = LucideIcon.Check,
        onClear = onRemove,
        clearLabel = Strings.Chips.removePhrase(label),
    )
}

/** A "Did you mean" suggestion: "Track: Security". Tapping it applies the filter. */
@Composable
fun SuggestionChip(kindLabel: String, label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    CaddieChip(label = "$kindLabel: $label", active = false, onClick = onClick, modifier = modifier, kind = ChipKind.Action)
}

/**
 * .chip-row: chips in one line that scrolls sideways, with the page gutter at both ends. [lead] is
 * the "Did you mean" text of the suggestion row.
 */
@Composable
fun ChipRow(
    modifier: Modifier = Modifier,
    lead: String? = null,
    content: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier
            .horizontalScroll(rememberScrollState())
            .padding(start = Caddie.dimens.gutter, end = Caddie.dimens.gutter, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (lead != null) Text(lead, style = Caddie.type.meta, color = Caddie.colors.text2)
        content()
    }
}

/** .chip-clear-all: the "Clear all" text button at the end of the chip row. */
@Composable
fun ClearAllButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier.heightIn(min = Caddie.dimens.minTouch).caddieClickable(Pill, onClick = onClick).padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(Strings.Chips.CLEAR_ALL, style = Caddie.type.buttonSmall, color = Caddie.colors.accentInk)
    }
}
