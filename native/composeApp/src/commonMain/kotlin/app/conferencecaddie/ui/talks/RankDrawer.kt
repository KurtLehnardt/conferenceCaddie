package app.conferencecaddie.ui.talks

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.conferencecaddie.shared.bundle.Conference
import app.conferencecaddie.shared.bundle.TalkTime
import app.conferencecaddie.shared.search.Ranking
import app.conferencecaddie.shared.search.SearchRequest
import app.conferencecaddie.shared.search.SearchResult
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.components.Pill
import app.conferencecaddie.ui.components.caddieClickable
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie

/**
 * "Why this rank" under a search result (web RankDrawer in web/src/components/search.tsx): a text
 * button with a chevron that opens a panel with the talk's place in the fused ranking, its place
 * among the keyword matches and among the nearest by meaning, and the filters applied. The web asks
 * the server for the ranks; here the search computed them already, so the panel opens at once.
 */
@Composable
fun RankDrawer(
    talkId: String,
    ranking: Ranking?,
    result: SearchResult,
    filters: SearchRequest,
    conference: Conference,
    startOpen: Boolean = false,
) {
    var open by rememberSaveable(talkId, result.searchText) { mutableStateOf(startOpen) }
    val c = Caddie.colors
    val turn by animateFloatAsState(if (open) 180f else 0f)
    Column(Modifier.fillMaxWidth().padding(top = 4.dp)) {
        Row(
            Modifier
                .offset(x = (-14).dp)
                .heightIn(min = Caddie.dimens.minTouch)
                .caddieClickable(Pill, role = Role.Button) { open = !open }
                .semantics { stateDescription = if (open) "Expanded" else "Collapsed" }
                .padding(horizontal = 14.dp)
                .testTag("rank-toggle-$talkId"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            LucideImage(LucideIcon.ChevronDown, null, Modifier.rotate(turn), size = 18.dp, tint = c.accentInk)
            Text(Strings.Rank.WHY, style = Caddie.type.buttonSmall, color = c.accentInk)
        }
        if (open) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(c.fill, RoundedCornerShape(Caddie.dimens.radius))
                    .padding(horizontal = 12.dp, vertical = 10.dp)
                    .semantics { liveRegion = LiveRegionMode.Polite }
                    .testTag("rank-panel-$talkId"),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (ranking == null) {
                    RankNote(Strings.Rank.UNAVAILABLE)
                } else {
                    RankRow(Strings.Rank.PLACE, ranking.rank.toString())
                    RankRow(Strings.Rank.KEYWORD, Strings.Rank.keyword(ranking.keywordRank, SearchResult.RANK_WINDOW))
                    if (result.semantic) RankRow(Strings.Rank.MEANING, Strings.Rank.meaning(ranking.semanticRank, SearchResult.SEMANTIC_K))
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(Strings.Rank.FILTERS, style = RankLabel, color = c.text2)
                        filterLines(filters, result, conference).forEach { line ->
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("•", style = Caddie.type.meta, color = c.text)
                                Text(line, style = Caddie.type.meta, color = c.text)
                            }
                        }
                    }
                    RankNote(if (result.semantic) Strings.Rank.NOTE_NATIVE else Strings.Rank.NOTE_KEYWORDS_ONLY, Modifier.padding(top = 2.dp))
                }
            }
        }
    }
}

private val RankLabel @Composable get() = Caddie.type.note.copy(fontSize = 12.sp, fontWeight = FontWeight.SemiBold)

@Composable
private fun RankRow(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = RankLabel, color = Caddie.colors.text2)
        Text(value, style = Caddie.type.meta, color = Caddie.colors.text)
    }
}

@Composable
private fun RankNote(text: String, modifier: Modifier = Modifier) {
    Text(text, style = Caddie.type.note, color = Caddie.colors.text2, modifier = modifier)
}

/** The filters a search applied, as the web's filterLines writes them. */
internal fun filterLines(f: SearchRequest, result: SearchResult, conference: Conference): List<String> = buildList {
    add(Strings.Rank.conferenceOnly(conference.name))
    add(if (f.includeEvents) Strings.Rank.WITH_EVENTS else Strings.Rank.TALKS_ONLY)
    f.day?.let { add(Strings.Rank.day(TalkTime.day(it))) }
    when {
        f.startBefore == NOON && f.startAfter == null -> add(Strings.Rank.MORNING)
        f.startAfter == NOON && f.startBefore == null -> add(Strings.Rank.AFTERNOON)
        else -> {
            f.startAfter?.let { add(Strings.Rank.startsAfter(hhmm(it))) }
            f.startBefore?.let { add(Strings.Rank.startsBefore(hhmm(it))) }
        }
    }
    if (f.tracks.isNotEmpty()) add(Strings.Rank.track(f.tracks.toList()))
    if (f.levels.isNotEmpty()) add(Strings.Rank.level(f.levels.toList()))
    for ((group, values) in f.tags) if (values.isNotEmpty()) add(Strings.Rank.tagGroup(group, values.toList()))
    val phrases = result.timePhrases.filter { it.applied }.map { it.label }
    if (phrases.isNotEmpty()) add(Strings.Rank.phrases(phrases))
    if (f.speakers.isNotEmpty()) add(Strings.Rank.speaker(f.speakers.toList()))
    if (f.rooms.isNotEmpty()) add(Strings.Rank.room(f.rooms.map { roomLabel(it) }))
    f.hasSlides?.let { add(if (it) Strings.Rank.HAS_SLIDES else Strings.Rank.NO_SLIDES) }
    if (f.hideSponsor) add(Strings.Rank.SPONSOR_HIDDEN)
    if (f.happeningNow) add(Strings.Rank.HAPPENING_NOW)
}

private const val NOON = 12 * 60

private fun hhmm(minutes: Int) = "${(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}"
