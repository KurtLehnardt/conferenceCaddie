package app.conferencecaddie.ui.shell

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.Demo
import app.conferencecaddie.ui.components.CaddieSheet
import app.conferencecaddie.ui.components.DemoPill
import app.conferencecaddie.ui.components.Hairline
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.components.SectionHeading
import app.conferencecaddie.ui.components.caddieClickable
import app.conferencecaddie.ui.components.showsDemoLabel
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie

/**
 * The conference switcher (web/src/components/switcher.tsx): searchable conferences first, the
 * current one with a check; conferences whose schedule is not available here are listed under
 * their own heading as links to the official schedule.
 */
@Composable
fun SwitcherSheet(
    conferences: List<ConferenceItem>?,
    current: String?,
    error: String?,
    onPick: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
    onClose: () -> Unit,
) {
    CaddieSheet(title = Strings.Switcher.TITLE, onClose = onClose, modifier = Modifier.testTag("switcher-sheet")) {
        if (error != null && conferences == null) {
            Text(error, style = Caddie.type.meta, color = Caddie.colors.text2, modifier = Modifier.padding(vertical = 8.dp))
        }
        val searchable = conferences.orEmpty().filter { it.searchable }
        val unavailable = conferences.orEmpty().filter { !it.searchable }
        Column(Modifier.fillMaxWidth().padding(bottom = 8.dp).semantics { isTraversalGroup = true }) {
            searchable.forEach { c ->
                ConferenceRow(c, current = c.id == current, trailing = if (c.id == current) LucideIcon.Check else null) { onPick(c.id) }
            }
        }
        if (unavailable.isNotEmpty()) {
            Hairline()
            SectionHeading(Strings.Switcher.UNAVAILABLE_HEADING, Modifier.padding(top = 16.dp, bottom = 4.dp))
            unavailable.forEach { c ->
                ConferenceRow(c, current = false, trailing = LucideIcon.ExternalLink, linkOut = true) {
                    c.officialUrl?.let(onOpenUrl)
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ConferenceRow(
    c: ConferenceItem,
    current: Boolean,
    trailing: LucideIcon?,
    linkOut: Boolean = false,
    onClick: () -> Unit,
) {
    val colors = Caddie.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .caddieClickable(RoundedCornerShape(8.dp), onClick = onClick)
            .semantics(mergeDescendants = true) {
                selected = current
                if (linkOut) contentDescription = c.name + (if (showsDemoLabel(c.demo)) ", ${Demo.SPOKEN}" else "") + Strings.Switcher.OPENS_OFFICIAL
            }
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            // A demo conference's pill follows its name, on the same line while both fit.
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    c.name,
                    style = Caddie.type.body.copy(fontWeight = FontWeight.SemiBold, lineHeight = Caddie.type.cardTitle.lineHeight),
                    color = if (current) colors.accentInk else colors.text,
                )
                if (showsDemoLabel(c.demo)) DemoPill(spoken = !linkOut)
            }
            if (c.meta.isNotEmpty()) Text(c.meta, style = Caddie.type.note, color = colors.text2)
        }
        if (trailing != null) {
            LucideImage(trailing, null, size = if (linkOut) 18.dp else 20.dp, tint = if (linkOut) colors.text2 else colors.accent)
        }
    }
}
