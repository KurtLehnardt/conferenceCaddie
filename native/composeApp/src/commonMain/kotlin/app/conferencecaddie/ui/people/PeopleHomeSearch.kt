package app.conferencecaddie.ui.people

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
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
import app.conferencecaddie.ui.components.CaddieIconButton
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.theme.Caddie

// The search field of the People home (web PeopleScreen.tsx PeopleSearchBar). The web draws it with
// its own markup rather than the talk search's SearchField: 300 characters instead of 200, a 20 dp
// Clear, no progress bar under it and no gutter of its own, so the People home draws its own too.
// Its "Around now" chip is the shell's CaddieChip at the search's 40 dp.

/** The longest people search the web accepts (the input's maxLength, and the API's cap). */
const val PEOPLE_QUERY_MAX = 300

/**
 * The people search field (.pp-search .search-field): 48 dp on the fill colour, radius 12, the
 * search icon 14 dp in, the text 44 dp in, a 2 dp accent ring while focused, and the 20 dp Clear
 * button once there is text. Input past 300 characters is cut. The keyboard's search key closes the
 * keyboard, as the web's form blurs the input on submit.
 */
@Composable
internal fun PeopleHomeSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    focusRequester: FocusRequester,
    modifier: Modifier = Modifier,
) {
    val c = Caddie.colors
    val shape = RoundedCornerShape(Caddie.dimens.radius)
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val focusManager = LocalFocusManager.current
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = Caddie.dimens.searchFieldHeight)
            .clip(shape)
            .background(c.fill)
            .then(if (focused) Modifier.border(2.dp, c.accent, shape) else Modifier),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LucideImage(LucideIcon.Search, null, Modifier.padding(start = 14.dp, end = 10.dp), size = 20.dp)
        Box(Modifier.weight(1f).padding(end = 4.dp), contentAlignment = Alignment.CenterStart) {
            if (value.isEmpty()) {
                // The web clips a long placeholder; here it wraps, so it stays readable at large font sizes.
                Text(PeopleStrings.SEARCH_PLACEHOLDER, style = Caddie.type.body, color = c.text2, modifier = Modifier.padding(vertical = 12.dp))
            }
            BasicTextField(
                value = value,
                onValueChange = { onValueChange(it.take(PEOPLE_QUERY_MAX)) },
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
                keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focusRequester)
                    .testTag("people-search-field")
                    .semantics { contentDescription = PeopleStrings.FIND_PEOPLE },
            )
        }
        if (value.isNotEmpty()) {
            CaddieIconButton(
                LucideIcon.X,
                PeopleStrings.CLEAR,
                onClick = {
                    onValueChange("")
                    runCatching { focusRequester.requestFocus() }
                },
                modifier = Modifier.padding(end = 2.dp),
                iconSize = 20.dp,
            )
        }
    }
}
