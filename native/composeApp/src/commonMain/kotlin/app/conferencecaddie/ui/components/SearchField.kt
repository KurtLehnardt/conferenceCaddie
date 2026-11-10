package app.conferencecaddie.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie

/**
 * .search-bar and .search-field: a field at least 48 dp tall (it grows with large text) on the fill
 * colour with the search icon, a clear button once there is text, the accent ring while focused,
 * and the thin progress bar underneath while [loading]. At most 200 characters, as on the web.
 */
@Composable
fun SearchField(
    value: String,
    onValueChange: (String) -> Unit,
    onSubmit: () -> Unit,
    modifier: Modifier = Modifier,
    loading: Boolean = false,
    placeholder: String = Strings.Search.PLACEHOLDER,
    label: String = Strings.Search.FIELD_LABEL,
) {
    val c = Caddie.colors
    val d = Caddie.dimens
    val shape = RoundedCornerShape(d.radius)
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    Column(modifier.fillMaxWidth().background(c.bg).padding(start = d.gutter, end = d.gutter, bottom = 8.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = d.searchFieldHeight)
                .clip(shape)
                .background(c.fill)
                .then(if (focused) Modifier.border(2.dp, c.accent, shape) else Modifier),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            LucideImage(LucideIcon.Search, null, Modifier.padding(start = 14.dp, end = 10.dp), size = 20.dp)
            Box(Modifier.weight(1f).padding(vertical = 8.dp), contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) Text(placeholder, style = Caddie.type.body, color = c.text2, maxLines = 1)
                BasicTextField(
                    value = value,
                    onValueChange = { onValueChange(it.take(200)) },
                    singleLine = true,
                    textStyle = Caddie.type.body.copy(color = c.text),
                    cursorBrush = SolidColor(c.accent),
                    interactionSource = interaction,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Text,
                        imeAction = ImeAction.Search,
                    ),
                    keyboardActions = KeyboardActions(onSearch = {
                        focusManager.clearFocus()
                        onSubmit()
                    }),
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focus)
                        .testTag("search-field")
                        .semantics { contentDescription = label },
                )
            }
            if (value.isNotEmpty()) {
                CaddieIconButton(
                    LucideIcon.X,
                    Strings.Search.CLEAR,
                    onClick = {
                        onValueChange("")
                        focus.requestFocus()
                    },
                    iconSize = 18.dp,
                    modifier = Modifier.padding(end = 2.dp),
                )
            }
        }
        ProgressBar(loading, Modifier.padding(top = 2.dp))
    }
}

/** .progress: a 2 dp bar with a sliding segment while [active]; empty space otherwise. */
@Composable
fun ProgressBar(active: Boolean, modifier: Modifier = Modifier) {
    BoxWithConstraints(modifier.fillMaxWidth().heightIn(min = 2.dp).height(2.dp).clip(RoundedCornerShape(2.dp))) {
        if (active) {
            val width = maxWidth
            val transition = rememberInfiniteTransition()
            val x by transition.animateFloat(-1f, 2.5f, infiniteRepeatable(tween(1000, easing = LinearEasing), RepeatMode.Restart))
            Box(
                Modifier
                    .width(width * 0.4f)
                    .height(2.dp)
                    .offset(x = width * 0.4f * x)
                    .background(Caddie.colors.accent, RoundedCornerShape(2.dp)),
            )
        }
    }
}
