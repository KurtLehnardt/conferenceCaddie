package app.conferencecaddie.ui.talks

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.bundle.InterestedTalk
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.bundle.TalkTime
import app.conferencecaddie.ui.InterestedPlaceholder
import app.conferencecaddie.ui.components.NoteText
import app.conferencecaddie.ui.components.SectionHeading
import app.conferencecaddie.ui.components.SegmentOption
import app.conferencecaddie.ui.components.Segmented
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie

/** My schedule's two views (web MyScheduleView), remembered on this device. */
enum class MyScheduleView { List, Day }

/**
 * My schedule (web/src/components/interested.tsx): the talks the person marked for this conference,
 * kept on this device only, as a list grouped by the conference's local day or as a timeline of one
 * day. Talks at the same time sit side by side with no warning, and nothing is planned for the
 * person. A marked talk that a newer bundle no longer holds is shown from the copy kept when it was
 * marked ([snapshots]), as the web keeps its copies in local storage.
 *
 * [shareAll] draws the web's ShareAllControls under the title, given the ids of the talks listed;
 * null leaves it out. It is not drawn for an empty list. [view] and [day] are the List or Day choice
 * and the Day view's day (null for today while the conference runs, else the first day).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun InterestedScreen(
    bundle: TalkBundle,
    interested: List<String>,
    nowMs: Long,
    onToggleInterested: (Talk) -> Unit,
    onOpenTalk: (Talk) -> Unit,
    onOpenUrl: (String) -> Unit,
    snapshots: Map<String, InterestedTalk> = emptyMap(),
    shareAll: (@Composable (talkIds: List<String>) -> Unit)? = null,
    view: MyScheduleView = MyScheduleView.List,
    onView: (MyScheduleView) -> Unit = {},
    day: String? = null,
    onDay: (String) -> Unit = {},
) {
    val talks = interestedTalks(bundle, interested, snapshots)
    if (talks.isEmpty()) {
        InterestedPlaceholder()
        return
    }
    val tz = bundle.conference.timeZone
    val days = talks.groupBy { it.day }
    val today = ConferenceClock.today(tz, nowMs)
    val shownDay = when {
        day != null && day in days -> day
        today in days -> today
        else -> days.keys.first()
    }
    val footnote = Strings.Interested.footnote(TalkTime.zoneLabel(tz, talks.first().start))
    LazyColumn(
        Modifier.fillMaxSize().testTag("interested-screen"),
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        item("head") {
            // .screen-head: the title, and the List or Day switch 168 dp wide on its right.
            Row(
                Modifier.fillMaxWidth().padding(start = Caddie.dimens.gutter, end = Caddie.dimens.gutter, top = 4.dp, bottom = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    Strings.Interested.TITLE,
                    style = Caddie.type.screenTitle,
                    color = Caddie.colors.text,
                    modifier = Modifier.weight(1f).semantics { heading() },
                )
                Segmented(
                    options = listOf(
                        SegmentOption(MyScheduleView.List, Strings.Interested.VIEW_LIST),
                        SegmentOption(MyScheduleView.Day, Strings.Interested.VIEW_DAY),
                    ),
                    value = view,
                    onChange = onView,
                    label = Strings.Interested.VIEW_LABEL,
                    modifier = Modifier.width(168.dp).testTag("my-schedule-view"),
                )
            }
        }
        if (shareAll != null) {
            item("share-all") {
                Box(Modifier.padding(horizontal = Caddie.dimens.gutter)) { shareAll(talks.map { it.talkId }) }
            }
        }
        if (view == MyScheduleView.Day) {
            item("days") {
                DayChips(days.keys.toList(), shownDay, onChange = onDay, today = today.takeIf { it in days })
            }
            item("timeline") {
                DayTimeline(days[shownDay].orEmpty(), shownDay, tz, nowMs, onOpenTalk)
            }
            item("footnote") { NoteText(footnote, Modifier.testTag("interested-footnote"), center = true) }
        } else {
            days.forEach { (d, list) ->
                // .day-header: the day in capitals, sticking under the app bar while its talks scroll.
                stickyHeader("day-$d") {
                    SectionHeading(
                        TalkTime.dayLong(d),
                        Modifier
                            .fillMaxWidth()
                            .background(Caddie.colors.bg)
                            .padding(horizontal = Caddie.dimens.gutter, vertical = 8.dp),
                    )
                }
                items(list, key = { it.talkId }) { talk ->
                    // As on the web, My schedule's cards carry no matched passage.
                    Box(Modifier.padding(bottom = 12.dp)) {
                        TalkResult(talk, bundle, emptyList(), true, nowMs, onToggleInterested, onOpenTalk, onOpenUrl, showEvidence = false)
                    }
                }
                item("day-end-$d") { Box(Modifier.padding(bottom = 4.dp)) }
            }
            item("footnote") { NoteText(footnote, Modifier.testTag("interested-footnote"), center = true) }
        }
    }
}

/**
 * The marked talks My schedule lists, in start order: each from the bundle while it holds the talk,
 * else from the copy kept when it was marked.
 */
internal fun interestedTalks(bundle: TalkBundle, interested: List<String>, snapshots: Map<String, InterestedTalk>): List<Talk> =
    interested.mapNotNull { bundle.talksById[it] ?: snapshots[it]?.toTalk() }
        .sortedWith(compareBy<Talk> { it.startEpochMs }.thenBy { it.talkId })
