package app.conferencecaddie.ui.talks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.bundle.TalkTime
import app.conferencecaddie.ui.components.NoteText
import app.conferencecaddie.ui.InterestedPlaceholder
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie

/**
 * My schedule (web/src/components/interested.tsx, List view): the talks the person marked for this
 * conference, grouped by the conference's local day in start order, kept on this device only.
 * Marked talks that a newer bundle no longer holds are left out.
 */
@Composable
fun InterestedScreen(
    bundle: TalkBundle,
    interested: List<String>,
    nowMs: Long,
    onToggleInterested: (Talk) -> Unit,
    onOpenTalk: (Talk) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    val talks = interested.mapNotNull { bundle.talksById[it] }.sortedWith(compareBy<Talk> { it.startEpochMs }.thenBy { it.talkId })
    if (talks.isEmpty()) {
        InterestedPlaceholder()
        return
    }
    val days = talks.groupBy { it.day }
    val c = Caddie.colors
    LazyColumn(
        Modifier.fillMaxSize().testTag("interested-screen"),
        contentPadding = PaddingValues(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item("title") {
            Text(
                Strings.Interested.TITLE,
                style = Caddie.type.appBarTitle.copy(fontSize = Caddie.type.sheetTitle.fontSize),
                color = c.text,
                modifier = Modifier.padding(horizontal = Caddie.dimens.gutter, vertical = 8.dp).semantics { heading() },
            )
        }
        days.forEach { (day, list) ->
            item("day-$day") {
                Text(
                    TalkTime.dayLong(day),
                    style = Caddie.type.sectionHeading,
                    color = c.text2,
                    modifier = Modifier.padding(horizontal = Caddie.dimens.gutter).padding(top = 8.dp).semantics { heading() },
                )
            }
            items(list, key = { it.talkId }) { talk ->
                TalkResult(talk, bundle, emptyList(), true, nowMs, onToggleInterested, onOpenTalk, onOpenUrl)
            }
        }
        item("footnote") {
            NoteText(
                Strings.Interested.footnote(TalkTime.zoneLabel(bundle.conference.timeZone, talks.first().start)),
                Modifier.padding(horizontal = Caddie.dimens.gutter),
            )
        }
    }
}
