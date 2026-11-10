package app.conferencecaddie.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.MOTION_MS

/** One choice of a [Segmented] control. */
data class SegmentOption<T>(val value: T, val label: String)

/** .segmented: a radio group drawn as one rounded track with the chosen segment raised. */
@Composable
fun <T> Segmented(
    options: List<SegmentOption<T>>,
    value: T,
    onChange: (T) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
) {
    val c = Caddie.colors
    val d = Caddie.dimens
    Row(
        modifier
            .fillMaxWidth()
            .background(c.fill, RoundedCornerShape(d.segmentedRadius))
            .padding(2.dp)
            .selectableGroup()
            .semantics { contentDescription = label },
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        options.forEach { option ->
            val on = option.value == value
            val shape = RoundedCornerShape(d.segmentRadius)
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = d.minTouch)
                    .then(if (on) Modifier.shadow(1.dp, shape) else Modifier)
                    .clip(shape)
                    .background(if (on) c.segmentOn else Color.Transparent)
                    .selectable(selected = on, role = Role.RadioButton, onClick = { onChange(option.value) })
                    .padding(horizontal = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    option.label,
                    style = if (on) Caddie.type.buttonSmall else Caddie.type.chip,
                    color = if (on) c.text else c.text2,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

/** .switch: the web's 48 by 28 dp switch, accent when on. The row around it carries the label. */
@Composable
fun CaddieSwitchVisual(checked: Boolean, modifier: Modifier = Modifier) {
    val c = Caddie.colors
    val track by animateColorAsState(if (checked) c.accent else c.fillStrong, tween(MOTION_MS))
    val x by animateDpAsState(if (checked) 20.dp else 0.dp, tween(MOTION_MS))
    Box(modifier.size(width = 48.dp, height = 28.dp).background(track, RoundedCornerShape(percent = 50))) {
        Box(
            Modifier
                .offset(x = 3.dp + x, y = 3.dp)
                .size(22.dp)
                .shadow(1.dp, CircleShape)
                .background(Color.White, CircleShape),
        )
    }
}

/** .option.option-switch: a label and a switch; the whole row toggles. */
@Composable
fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .toggleable(value = checked, role = Role.Switch, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(label, style = Caddie.type.body, color = Caddie.colors.text, modifier = Modifier.weight(1f))
        CaddieSwitchVisual(checked)
    }
}

/** .option with a radio or checkbox: a label, an optional count, and the choice mark. */
@Composable
fun OptionRow(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    count: Int? = null,
    radio: Boolean = false,
) {
    val c = Caddie.colors
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .then(
                if (radio) {
                    Modifier.selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
                } else {
                    Modifier.toggleable(value = selected, role = Role.Checkbox, onValueChange = { onClick() })
                },
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        val shape = if (radio) CircleShape else RoundedCornerShape(4.dp)
        Box(
            Modifier
                .size(20.dp)
                .then(if (selected) Modifier.background(c.accent, shape) else Modifier.border(2.dp, c.text2, shape)),
            contentAlignment = Alignment.Center,
        ) {
            if (selected && radio) Box(Modifier.size(8.dp).background(c.onAccent, CircleShape))
            if (selected && !radio) LucideImage(LucideIcon.Check, null, size = 14.dp, tint = c.onAccent, strokeWidth = 3f)
        }
        Text(label, style = Caddie.type.body, color = c.text, modifier = Modifier.weight(1f))
        if (count != null) Text(count.toString(), style = Caddie.type.meta, color = c.text2)
    }
}

/** A capitalised section heading (.settings-heading, .conf-heading, .day-header, sheet legends). */
@Composable
fun SectionHeading(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        style = Caddie.type.sectionHeading,
        color = Caddie.colors.text2,
        modifier = modifier.semantics { heading() },
    )
}

/** .settings-group: a heading and a card of rows. */
@Composable
fun SettingsGroup(heading: String, modifier: Modifier = Modifier, note: String? = null, content: @Composable ColumnScope.() -> Unit) {
    val c = Caddie.colors
    val shape = RoundedCornerShape(Caddie.dimens.radius)
    Column(modifier.fillMaxWidth()) {
        SectionHeading(heading, Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 6.dp))
        Column(
            Modifier.fillMaxWidth().clip(shape).background(c.surface).border(1.dp, c.border, shape),
            content = content,
        )
        if (note != null) {
            Text(note, style = Caddie.type.note, color = c.text2, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp))
        }
    }
}

/** .settings-row: a padded row at least 48 dp tall; rows after the first get a hairline on top. */
@Composable
fun SettingsRow(
    modifier: Modifier = Modifier,
    first: Boolean = false,
    onClick: (() -> Unit)? = null,
    enabled: Boolean = true,
    role: Role = Role.Button,
    content: @Composable RowScope.() -> Unit,
) {
    Column(modifier.fillMaxWidth()) {
        if (!first) Hairline()
        Row(
            Modifier
                .fillMaxWidth()
                .alpha(if (enabled) 1f else 0.45f)
                .then(
                    if (onClick != null) {
                        Modifier.caddieClickable(RoundedCornerShape(0.dp), role = role, enabled = enabled, onClick = onClick)
                    } else {
                        Modifier
                    },
                )
                .heightIn(min = 48.dp)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
    }
}

/** .settings-nav: an icon, a label with a hint under it, and a chevron. */
@Composable
fun SettingsNavRow(
    icon: LucideIcon,
    label: String,
    hint: String?,
    onClick: () -> Unit,
    first: Boolean = false,
    enabled: Boolean = true,
) {
    SettingsRow(first = first, onClick = onClick, enabled = enabled) {
        LucideImage(icon, null, size = 20.dp)
        Column(Modifier.weight(1f)) {
            Text(label, style = Caddie.type.body.copy(fontWeight = Caddie.type.chip.fontWeight), color = Caddie.colors.text)
            if (hint != null) Text(hint, style = Caddie.type.meta, color = Caddie.colors.text2)
        }
        LucideImage(LucideIcon.ChevronRight, null, size = 18.dp)
    }
}

/** .settings-link: accent text and a trailing icon, such as "Source code". */
@Composable
fun SettingsLinkRow(label: String, icon: LucideIcon, onClick: () -> Unit, first: Boolean = false, danger: Boolean = false, enabled: Boolean = true) {
    SettingsRow(first = first, onClick = onClick, enabled = enabled) {
        val color = if (danger) Caddie.colors.danger else Caddie.colors.accentInk
        Text(label, style = Caddie.type.body, color = color, modifier = Modifier.weight(1f))
        LucideImage(icon, null, size = 18.dp, tint = color)
    }
}

/** A label and a value on the right (.settings-value), such as "Version". */
@Composable
fun SettingsValueRow(label: String, value: String, first: Boolean = false) {
    SettingsRow(first = first) {
        Text(label, style = Caddie.type.body, color = Caddie.colors.text, modifier = Modifier.weight(1f))
        Text(value, style = Caddie.type.body, color = Caddie.colors.text2, textAlign = TextAlign.End)
    }
}

/** .settings-text: a paragraph in a settings card. */
@Composable
fun SettingsTextRow(text: String, first: Boolean = false) {
    SettingsRow(first = first) {
        Text(text, style = Caddie.type.stateBody, color = Caddie.colors.text)
    }
}

