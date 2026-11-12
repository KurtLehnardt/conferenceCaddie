package app.conferencecaddie.ui.talks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.bundle.Conference
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.ui.components.CaddieIconButton
import app.conferencecaddie.ui.components.LinkButton
import app.conferencecaddie.ui.components.NoteText
import app.conferencecaddie.ui.components.caddieClickable
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.shell.isWebLink
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.minimumTouchTarget

/**
 * "Related talks" under a talk card, closed until tapped (web RelatedTalks in
 * web/src/components/talk.tsx). The web asks the server; here the list is the bundle's precomputed
 * `related` entry, so it works offline, and a related talk opens in the talk sheet.
 */
@Composable
fun RelatedTalks(
    talkId: String,
    related: List<Talk>,
    conference: Conference,
    onOpenTalk: (Talk) -> Unit,
    startOpen: Boolean = false,
    onOpenUrl: ((String) -> Unit)? = null,
) {
    var open by rememberSaveable(talkId) { mutableStateOf(startOpen) }
    val c = Caddie.colors
    Column(Modifier.fillMaxWidth().padding(top = 4.dp)) {
        LinkButton(
            Strings.Talk.RELATED,
            icon = null,
            modifier = Modifier.semantics { stateDescription = if (open) "Expanded" else "Collapsed" },
        ) { open = !open }
        if (open) {
            if (related.isEmpty()) {
                NoteText(Strings.Talk.RELATED_NONE)
            } else {
                Column(Modifier.testTag("related-talks"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    related.forEach { r ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(
                                Modifier
                                    .weight(1f)
                                    .minimumTouchTarget()
                                    .heightIn(min = Caddie.dimens.minTouch)
                                    .caddieClickable(RoundedCornerShape(8.dp), role = Role.Button) { onOpenTalk(r) }
                                    .padding(vertical = 6.dp),
                            ) {
                                Text(r.title, style = Caddie.type.body, color = c.accentInk)
                                Text(
                                    (if (r.speakers.isNotEmpty()) r.speakers.joinToString(", ") + " · " else "") + whenText(r, conference),
                                    style = Caddie.type.meta,
                                    color = c.text2,
                                )
                            }
                            // The web links each related talk to the official site; here the row opens the
                            // talk in the sheet, and this button opens the official page.
                            val url = r.url?.takeIf { isWebLink(it) }
                            if (onOpenUrl != null && url != null) {
                                CaddieIconButton(
                                    LucideIcon.ExternalLink,
                                    Strings.Talk.relatedOfficial(r.title),
                                    onClick = { onOpenUrl(url) },
                                    iconSize = 18.dp,
                                    tint = c.accentInk,
                                    modifier = Modifier.testTag("related-official-${r.talkId}"),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
