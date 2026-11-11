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
import app.conferencecaddie.shared.bundle.InterestedTalk
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.bundle.TalkTime
import app.conferencecaddie.ui.components.NoteText
import app.conferencecaddie.ui.components.SectionHeading
import app.conferencecaddie.ui.InterestedPlaceholder
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie

/**
 * My schedule (web/src/components/interested.tsx, List view): the talks the person marked for this
 * conference, grouped by the conference's local day in start order, kept on this device only.
 * A marked talk that a newer bundle no longer holds is shown from the copy kept when it was marked
 * ([snapshots]), as the web keeps its copies in local storage.
 */
@Composable
fun InterestedScreen(
    bundle: TalkBundle,
    interested: List<String>,
    nowMs: Long,
    onToggleInterested: (Talk) -> Unit,
    onOpenTalk: (Talk) -> Unit,
    onOpenUrl: (String) -> Unit,
    snapshots: Map<String, InterestedTalk> = emptyMap(),
) {
    val talks = interested.mapNotNull { bundle.talksById[it] ?: snapshots[it]?.toTalk() }.sortedWith(compareBy<Talk> { it.startEpochMs }.thenBy { it.talkId })
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
                // .day-header: the web writes the day in capitals.
                SectionHeading(
                    TalkTime.dayLong(day),
                    Modifier.padding(horizontal = Caddie.dimens.gutter).padding(top = 8.dp).semantics { heading() },
                )
            }
            items(list, key = { it.talkId }) { talk ->
                // As on the web, My schedule's cards carry no matched passage.
                TalkResult(talk, bundle, emptyList(), true, nowMs, onToggleInterested, onOpenTalk, onOpenUrl, showEvidence = false)
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
