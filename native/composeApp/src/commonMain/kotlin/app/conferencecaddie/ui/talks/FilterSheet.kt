package app.conferencecaddie.ui.talks

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.bundle.Conference
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.bundle.TalkTime
import app.conferencecaddie.shared.search.FacetCount
import app.conferencecaddie.shared.search.SearchRequest
import app.conferencecaddie.shared.search.SearchResult
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.CaddieSheet
import app.conferencecaddie.ui.components.Hairline
import app.conferencecaddie.ui.components.NoteText
import app.conferencecaddie.ui.components.OptionRow
import app.conferencecaddie.ui.components.SectionHeading
import app.conferencecaddie.ui.components.SegmentOption
import app.conferencecaddie.ui.components.Segmented
import app.conferencecaddie.ui.components.SwitchRow
import app.conferencecaddie.ui.strings.Strings

/**
 * The Filters sheet (web FilterSheet): Day, Time, Track, Level, each tag group, Slides, Sponsor
 * content and Events and showcases, with counts that already reflect the other filters, and a
 * footer with "Clear all" and "Show 12 talks". Values with no talks are hidden unless selected.
 * With [schedule] (the full schedule, which has its own day chips) Day and Time are left out.
 */
@Composable
fun FilterSheet(
    conference: Conference,
    bundle: TalkBundle,
    filters: SearchRequest,
    result: SearchResult?,
    onChange: (SearchRequest) -> Unit,
    onClose: () -> Unit,
    schedule: Boolean = false,
) {
    val f = filters
    val facets = result?.facets
    val count = SearchModel.activeFilterCount(f)
    CaddieSheet(
        title = Strings.FilterSheet.TITLE,
        onClose = onClose,
        closeLabel = Strings.FilterSheet.CLOSE,
        modifier = Modifier.testTag("filter-sheet"),
        footer = {
            CaddieButton(Strings.FilterSheet.CLEAR_ALL, { onChange(SearchRequest(ignorePhrases = f.ignorePhrases)) }, variant = ButtonVariant.Text, enabled = count > 0)
            // The web's .sheet-footer .btn-primary takes the rest of the row.
            CaddieButton(
                Strings.FilterSheet.show(result?.total, f.includeEvents),
                onClose,
                modifier = Modifier.weight(1f),
                variant = ButtonVariant.Primary,
            )
        },
    ) {
        if (!schedule) {
            Section(Strings.FilterSheet.DAY) {
                OptionRow(Strings.FilterSheet.ANY_DAY, f.day == null, { onChange(f.copy(day = null)) }, radio = true)
                visible(facets?.day.orEmpty(), listOfNotNull(f.day)).forEach { d ->
                    OptionRow(TalkTime.day(d.value), f.day == d.value, { onChange(f.copy(day = d.value)) }, count = d.count, radio = true)
                }
            }
            Section(Strings.FilterSheet.TIME) {
                Segmented(
                    options = listOf(
                        SegmentOption(TimeValue.Any, Strings.FilterSheet.ANY_TIME),
                        SegmentOption(TimeValue.Morning, Strings.Chips.MORNING),
                        SegmentOption(TimeValue.Afternoon, Strings.Chips.AFTERNOON),
                    ),
                    value = timeValue(f),
                    onChange = { onChange(withTime(f, it)) },
                    label = Strings.FilterSheet.TIME_OF_DAY,
                )
            }
        }
        Section(Strings.FilterSheet.TRACK) {
            val tracks = visible(facets?.track.orEmpty(), f.tracks.toList())
            if (tracks.isEmpty()) NoteText(Strings.FilterSheet.NO_TRACKS)
            tracks.forEach { t ->
                OptionRow(t.value, t.value in f.tracks, { onChange(f.copy(tracks = toggle(f.tracks, t.value))) }, count = t.count)
            }
        }
        if (conference.hasLevel) {
            Section(Strings.FilterSheet.LEVEL) {
                val levels = visible(facets?.level.orEmpty(), f.levels.toList())
                if (levels.isEmpty()) NoteText(Strings.FilterSheet.NO_LEVELS)
                levels.forEach { l ->
                    OptionRow(l.value, l.value in f.levels, { onChange(f.copy(levels = toggle(f.levels, l.value))) }, count = l.count)
                }
            }
        }
        conference.tagGroups.forEach { group ->
            Section(group) {
                val selected = f.tags[group].orEmpty()
                val values = visible(facets?.tags?.firstOrNull { it.group == group }?.values.orEmpty(), selected.toList())
                if (values.isEmpty()) NoteText(Strings.FilterSheet.NONE_IN_RESULTS)
                values.forEach { v ->
                    OptionRow(v.value, v.value in selected, { onChange(f.copy(tags = toggleTag(f.tags, group, v.value))) }, count = v.count)
                }
            }
        }
        if (showSlides(f, result)) {
            Section(Strings.FilterSheet.SLIDES) {
                OptionRow(Strings.FilterSheet.ANY, f.hasSlides == null, { onChange(f.copy(hasSlides = null)) }, radio = true)
                visible(facets?.hasSlides.orEmpty(), listOfNotNull(f.hasSlides)).forEach { s ->
                    OptionRow(
                        if (s.value) Strings.Chips.HAS_SLIDES else Strings.Chips.NO_SLIDES,
                        f.hasSlides == s.value,
                        { onChange(f.copy(hasSlides = s.value)) },
                        count = s.count,
                        radio = true,
                    )
                }
            }
        }
        Section(Strings.FilterSheet.SPONSOR) {
            SwitchRow(Strings.FilterSheet.HIDE_SPONSOR, f.hideSponsor, { onChange(f.copy(hideSponsor = it)) })
        }
        Section(Strings.FilterSheet.EVENTS, last = true) {
            SwitchRow(Strings.FilterSheet.INCLUDE_EVENTS, f.includeEvents, { onChange(f.copy(includeEvents = it)) })
        }
    }
}

/** .sheet-section: a legend, its options and a hairline under it (none under the last one). */
@Composable
private fun Section(title: String, last: Boolean = false, content: @Composable () -> Unit) {
    Column(Modifier.padding(vertical = 12.dp)) {
        SectionHeading(title, Modifier.padding(bottom = 4.dp))
        content()
    }
    if (!last) Hairline()
}

/** Facet options with zero-count values hidden unless they are selected. */
private fun <T> visible(buckets: List<FacetCount<T>>, selected: List<T>): List<FacetCount<T>> {
    val shown = buckets.filter { it.count > 0 || it.value in selected }.toMutableList()
    for (s in selected) if (shown.none { it.value == s }) shown += FacetCount(s, 0)
    return shown
}

private fun toggle(set: Set<String>, value: String): Set<String> = if (value in set) set - value else set + value
