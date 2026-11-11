package app.conferencecaddie.ui.talks

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.bundle.TalkTime
import app.conferencecaddie.ui.components.CaddieSheet
import app.conferencecaddie.ui.components.NoteText
import app.conferencecaddie.ui.components.SectionHeading
import app.conferencecaddie.ui.components.TalkCard
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie

/**
 * One talk in a sheet (web TalkSheet): the full card, then what the native app adds from the
 * bundle: each speaker with their one-line tagline (names and taglines only, as public bundles
 * carry nothing else), the whole abstract, and the related talks the bundle lists, which open in
 * the same sheet and work offline.
 */
@Composable
fun TalkSheet(
    talk: Talk,
    bundle: TalkBundle,
    related: List<Talk>,
    interested: Boolean,
    nowMs: Long,
    onToggleInterested: (Talk) -> Unit,
    onOpenTalk: (Talk) -> Unit,
    onOpenUrl: (String) -> Unit,
    onClose: () -> Unit,
) {
    val c = Caddie.colors
    CaddieSheet(title = Strings.Talk.SHEET_TITLE, onClose = onClose, modifier = Modifier.testTag("talk-sheet")) {
        TalkCard(
            title = talk.title,
            whenText = whenText(talk, bundle.conference),
            speakers = talk.speakers.joinToString(", ").takeIf { it.isNotEmpty() },
            room = talk.room,
            tags = talkTags(talk),
            interested = interested,
            onToggleInterested = { onToggleInterested(talk) },
            ended = TalkTime.hasEnded(talk, nowMs),
            isEvent = talk.kind == "ambient",
            links = cardLinks(talk),
            onOpenLink = onOpenUrl,
            flat = true,
            modifier = Modifier.testTag("talk-sheet-card"),
            extra = if (talk.kind == "talk") {
                { RelatedTalks(talk.talkId, related, bundle.conference, onOpenTalk, startOpen = true, onOpenUrl = onOpenUrl) }
            } else {
                null
            },
        )
        if (talk.speakers.isNotEmpty()) {
            SectionHeading(TalkStrings.SPEAKERS, Modifier.padding(top = 16.dp, bottom = 4.dp))
            talk.speakers.forEachIndexed { i, name ->
                Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Text(name, style = Caddie.type.body, color = c.text)
                    talk.speakerTaglines.getOrNull(i)?.let { Text(it, style = Caddie.type.meta, color = c.text2) }
                }
            }
        }
        if (talk.abstract.isNotBlank()) {
            SectionHeading(TalkStrings.ABSTRACT, Modifier.padding(top = 16.dp, bottom = 4.dp))
            Text(talk.abstract, style = Caddie.type.body, color = c.text)
        }
        NoteText(
            TalkStrings.attribution(bundle.attribution.licensor, bundle.attribution.license),
            Modifier.padding(top = 20.dp, bottom = 16.dp),
        )
    }
}
