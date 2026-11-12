package app.conferencecaddie.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.minimumTouchTarget

// The topic picker's controls, from web/src/people/people.css: .pp-chip, .pp-field and .pp-text.

/**
 * .pp-chip: a 44 dp topic pill with a plus (off) or a check (on), the label and, when known, how
 * many talks carry the topic. On, it fills with the accent colour. The count stays when the chip is
 * on, so a tap never changes its width. [enabled] false is the faded chip of a full set.
 */
@Composable
fun TopicChip(
    label: String,
    on: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
    count: Int? = null,
    enabled: Boolean = true,
) {
    val c = Caddie.colors
    val usable = enabled || on
    val fg = if (on) c.onAccent else c.text
    val iconTint = if (on) c.onAccent else c.text2
    Row(
        modifier
            .minimumTouchTarget()
            .heightIn(min = Caddie.dimens.minTouch)
            .alpha(if (usable) 1f else 0.45f)
            .caddieClickable(Pill, enabled = usable, onClick = onToggle)
            .background(if (on) c.accent else c.surface, Pill)
            .then(if (on) Modifier else Modifier.border(1.dp, c.borderStrong, Pill))
            .semantics {
                contentDescription = Strings.Topics.chipLabel(label, count)
                stateDescription = if (on) "Selected" else "Not selected"
            }
            .padding(start = 10.dp, end = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        LucideImage(if (on) LucideIcon.Check else LucideIcon.Plus, null, size = textIconSize(16.dp), tint = iconTint)
        Text(
            label,
            style = Caddie.type.body.copy(fontSize = 15.sp, fontWeight = FontWeight.Medium),
            color = fg,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 240.dp),
        )
        if (count != null) {
            Text(count.toString(), style = Caddie.type.note.copy(fontSize = 12.sp), color = if (on) c.onAccent.copy(alpha = 0.85f) else c.text2)
        }
    }
}

/**
 * .pp-field: a 44 dp pill on the fill colour with the search icon, a clear button once there is
 * text, and the accent outline while focused. [fieldTag] tags the text field itself, for tests.
 */
@Composable
fun PillSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    label: String,
    modifier: Modifier = Modifier,
    maxLength: Int = 60,
    fieldTag: String? = null,
) {
    val c = Caddie.colors
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = Caddie.dimens.minTouch)
            .background(c.fill, Pill)
            .then(if (focused) Modifier.border(2.dp, c.accent, Pill) else Modifier),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LucideImage(LucideIcon.Search, null, Modifier.padding(start = 14.dp), size = textIconSize(18.dp))
        Box(Modifier.weight(1f).padding(start = 10.dp, end = 8.dp), contentAlignment = Alignment.CenterStart) {
            if (value.isEmpty()) Text(placeholder, style = Caddie.type.body, color = c.text2, maxLines = 1)
            BasicTextField(
                value = value,
                onValueChange = { onValueChange(it.take(maxLength)) },
                singleLine = true,
                textStyle = Caddie.type.body.copy(color = c.text),
                cursorBrush = SolidColor(c.accent),
                interactionSource = interaction,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Search),
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = label }.then(if (fieldTag != null) Modifier.testTag(fieldTag) else Modifier),
            )
        }
        if (value.isNotEmpty()) {
            CaddieIconButton(LucideIcon.X, Strings.Topics.CLEAR, onClick = { onValueChange("") }, iconSize = 18.dp)
        }
    }
}

/**
 * .pp-text: a labelled text field (a text area when [lines] is more than one) on the page colour,
 * with a strong border, the accent outline while focused, and an optional hint under it.
 */
@Composable
fun LabelledTextField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    maxLength: Int = 500,
    lines: Int = 3,
    placeholder: String? = null,
    hint: String? = null,
) {
    val c = Caddie.colors
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val shape = RoundedCornerShape(10.dp)
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = Caddie.type.meta.copy(fontWeight = FontWeight.SemiBold), color = c.text)
        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = if (lines > 1) (22 * lines + 20).dp else Caddie.dimens.minTouch)
                .background(c.bg, shape)
                .border(if (focused) 2.dp else 1.dp, if (focused) c.accent else c.borderStrong, shape)
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            if (value.isEmpty() && placeholder != null) Text(placeholder, style = Caddie.type.body.copy(lineHeight = 22.sp), color = c.text2)
            BasicTextField(
                value = value,
                onValueChange = { onValueChange(it.take(maxLength)) },
                singleLine = lines <= 1,
                minLines = lines.coerceAtLeast(1),
                textStyle = Caddie.type.body.copy(color = c.text, lineHeight = 22.sp),
                cursorBrush = SolidColor(c.accent),
                interactionSource = interaction,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                modifier = Modifier.fillMaxWidth().testTag("labelled-field").semantics { contentDescription = label },
            )
        }
        if (hint != null) Text(hint, style = Caddie.type.meta, color = c.text2)
    }
}

/**
 * [size] grown with the system font size, up to twice, for an icon that sits in a line of text. The
 * web's icons grow with its text when the page is zoomed for larger text; one that stayed small next
 * to large text would be hard to see and would look out of place.
 */
@Composable
internal fun textIconSize(size: Dp): Dp = size * LocalDensity.current.fontScale.coerceIn(1f, 2f)
