package app.conferencecaddie.ui.talks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.bundle.TalkTime
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.search.SearchRequest
import app.conferencecaddie.shared.search.SearchResult
import app.conferencecaddie.ui.components.CaddieChip
import app.conferencecaddie.ui.components.ChipKind
import app.conferencecaddie.ui.components.ChipRow
import app.conferencecaddie.ui.components.ClearAllButton
import app.conferencecaddie.ui.components.ErrorBanner
import app.conferencecaddie.ui.components.FiltersChip
import app.conferencecaddie.ui.components.NoteText
import app.conferencecaddie.ui.components.SearchField
import app.conferencecaddie.ui.components.SkeletonCard
import app.conferencecaddie.ui.components.StateAction
import app.conferencecaddie.ui.components.StateView
import app.conferencecaddie.ui.components.SuggestionChip
import app.conferencecaddie.ui.components.TalkCard
import app.conferencecaddie.ui.components.TimePhraseChip
import app.conferencecaddie.ui.components.highlight
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie

/**
 * The Search tab's Search view (web/src/components/search.tsx): the search field, the "Did you
 * mean" suggestions, the chip row of filters and time phrases, the results count and the talk
 * cards. Everything runs on the device over the conference's bundle.
 */
@Composable
fun SearchScreen(
    model: SearchModel,
    bundle: TalkBundle,
    interested: Set<String>,
    nowMs: Long,
    onToggleInterested: (Talk) -> Unit,
    onOpenTalk: (Talk) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    val result = model.result
    val conference = bundle.conference
    val listState = rememberLazyListState()
    // A new result starts at the top, where its suggestions and chips are. Without this, the list
    // keeps its first visible item by key, and a "Did you mean" row that appears above it stays
    // out of sight.
    LaunchedEffect(result) { if (result != null) listState.scrollToItem(0) }
    Column(Modifier.fillMaxSize().testTag("search-screen")) {
        SearchField(
            value = model.input,
            onValueChange = model::onInput,
            onSubmit = model::submit,
            loading = model.loading,
        )
        LazyColumn(
            Modifier.fillMaxSize().testTag("search-results"),
            state = listState,
            contentPadding = PaddingValues(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (result != null && result.suggestions.isNotEmpty()) {
                item("suggestions") {
                    ChipRow(lead = Strings.Search.DID_YOU_MEAN) {
                        result.suggestions.forEach { s ->
                            SuggestionChip(suggestionKind(s.kind), s.label, onClick = { model.apply(s) })
                        }
                    }
                }
            }
            item("chips") { FilterChips(model, bundle, result) }
            if (result != null && !result.happeningNowAvailable) {
                item("now-note") {
                    val range = if (conference.startDate != null && conference.endDate != null) {
                        TalkTime.dateRange(conference.startDate!!, conference.endDate!!)
                    } else {
                        null
                    }
                    NoteText(
                        Strings.Chips.nowOff(conference.name, range, conference.timeZone ?: "UTC"),
                        Modifier.padding(horizontal = Caddie.dimens.gutter),
                    )
                }
            }
            val error = model.error
            when {
                // web/src/components/search.tsx: a failed search with nothing to show is a state with
                // Retry; with earlier results it is a banner above them.
                result == null && error != null -> item("error") {
                    StateView(
                        Modifier.testTag("search-error"),
                        icon = LucideIcon.CircleExclamationPoint,
                        title = Strings.Blockers.SOMETHING_WRONG,
                        body = error,
                        action = StateAction(Strings.Common.RETRY, model::retry),
                    )
                }
                result == null -> items(3) { SkeletonCard(Modifier.padding(horizontal = Caddie.dimens.gutter)) }
                else -> {
                    val browse = result.searchText.isBlank()
                    if (error != null) item("error") { ErrorBanner(error, Modifier.testTag("search-error"), onRetry = model::retry) }
                    item("count") {
                        Text(
                            Strings.Search.count(result.total, browse, model.filters.includeEvents),
                            style = Caddie.type.meta,
                            color = Caddie.colors.text2,
                            modifier = Modifier
                                .padding(horizontal = Caddie.dimens.gutter)
                                .testTag("results-count")
                                .semantics { liveRegion = LiveRegionMode.Polite },
                        )
                    }
                    if (result.talks.isEmpty()) {
                        item("empty") {
                            StateView(
                                icon = LucideIcon.SearchX,
                                body = Strings.Search.NO_MATCH,
                                action = if (model.activeFilterCount > 0) StateAction(Strings.Search.CLEAR_ALL_FILTERS, model::clearFilters) else null,
                            )
                        }
                    } else {
                        val terms = markTerms(result.searchText)
                        items(result.talks, key = { it.talkId }) { talk ->
                            TalkResult(talk, bundle, terms, talk.talkId in interested, nowMs, onToggleInterested, onOpenTalk, onOpenUrl)
                        }
                    }
                }
            }
        }
    }
    if (model.sheet != null) {
        FilterSheet(
            conference = conference,
            bundle = bundle,
            filters = model.filters,
            result = result,
            onChange = model::updateFilters,
            onClose = { model.sheet = null },
        )
    }
}

@Composable
internal fun TalkResult(
    talk: Talk,
    bundle: TalkBundle,
    terms: List<String>,
    interested: Boolean,
    nowMs: Long,
    onToggleInterested: (Talk) -> Unit,
    onOpenTalk: (Talk) -> Unit,
    onOpenUrl: (String) -> Unit,
    showEvidence: Boolean = true,
    peopleControls: (@Composable (Talk) -> Unit)? = null,
) {
    val related = bundle.related[talk.talkId].orEmpty().mapNotNull { bundle.talksById[it] }
    TalkCard(
        title = talk.title,
        whenText = whenText(talk, bundle.conference),
        modifier = Modifier.padding(horizontal = Caddie.dimens.gutter).testTag("talk-${talk.talkId}"),
        speakers = talk.speakers.joinToString(", ").takeIf { it.isNotEmpty() },
        room = talk.room,
        tags = talkTags(talk),
        evidence = if (showEvidence) evidenceText(talk)?.let { highlight(it, terms) } else null,
        interested = interested,
        onToggleInterested = { onToggleInterested(talk) },
        ended = TalkTime.hasEnded(talk, nowMs),
        isEvent = talk.kind == "ambient",
        links = cardLinks(talk),
        onOpenLink = onOpenUrl,
        onClick = { onOpenTalk(talk) },
        extra = if (talk.kind == "talk") {
            {
                // The web's TalkPeopleControls sit between "I was there" and Related talks.
                peopleControls?.invoke(talk)
                RelatedTalks(talk.talkId, related, bundle.conference, onOpenTalk)
            }
        } else {
            null
        },
    )
}

private fun suggestionKind(kind: String) = when (kind) {
    "track" -> Strings.Search.SUGGESTION_TRACK
    "room" -> Strings.Search.SUGGESTION_ROOM
    "speaker" -> Strings.Search.SUGGESTION_SPEAKER
    else -> Strings.Search.SUGGESTION_TAG
}

internal enum class TimeValue { Any, Morning, Afternoon }

internal fun timeValue(f: SearchRequest): TimeValue = when {
    f.startBefore == NOON && f.startAfter == null -> TimeValue.Morning
    f.startAfter == NOON && f.startBefore == null -> TimeValue.Afternoon
    else -> TimeValue.Any
}

internal fun withTime(f: SearchRequest, v: TimeValue): SearchRequest = when (v) {
    TimeValue.Morning -> f.copy(startAfter = null, startBefore = NOON)
    TimeValue.Afternoon -> f.copy(startAfter = NOON, startBefore = null)
    TimeValue.Any -> f.copy(startAfter = null, startBefore = null)
}

private const val NOON = 12 * 60

/** The values of a tag group that the bundle knows. */
internal fun tagValues(bundle: TalkBundle, group: String): List<String> =
    bundle.facets.filter { it.kind == "tag" && it.group == group }.map { it.value }

/** The "Has slides" chip is hidden when no talk has slides and it is not selected. */
internal fun showSlides(f: SearchRequest, result: SearchResult?): Boolean =
    f.hasSlides != null || result?.facets?.hasSlides?.any { it.value && it.count > 0 } == true

/** The chip row (web ChipRow): phrases, Filters, Happening now, Day, Time, Track, Level, tags and toggles. */
@Composable
private fun FilterChips(model: SearchModel, bundle: TalkBundle, result: SearchResult?) {
    val f = model.filters
    val conference = bundle.conference
    val nowOff = result != null && !result.happeningNowAvailable
    val set = model::updateFilters
    ChipRow(Modifier.fillMaxWidth().testTag("chip-row")) {
        result?.timePhrases?.filter { it.applied }?.forEach { p ->
            TimePhraseChip(p.label, p.days.singleOrNull()?.let { TalkTime.day(it) }, onRemove = { model.removePhrase(p.key) })
        }
        FiltersChip(model.activeFilterCount, onClick = { model.sheet = "" })
        CaddieChip(
            label = Strings.Chips.HAPPENING_NOW,
            active = f.happeningNow,
            onClick = { if (!nowOff || f.happeningNow) set(f.copy(happeningNow = !f.happeningNow)) },
            leadingIcon = LucideIcon.Clock,
            disabled = nowOff,
        )
        CaddieChip(
            label = f.day?.let { TalkTime.day(it) } ?: Strings.Chips.DAY,
            active = f.day != null,
            onClick = { model.sheet = "day" },
            kind = ChipKind.Dropdown,
            onClear = { set(f.copy(day = null)) },
            clearLabel = Strings.Chips.CLEAR_DAY,
        )
        val time = timeValue(f)
        CaddieChip(
            label = when (time) {
                TimeValue.Morning -> Strings.Chips.MORNING
                TimeValue.Afternoon -> Strings.Chips.AFTERNOON
                TimeValue.Any -> Strings.Chips.TIME
            },
            active = time != TimeValue.Any,
            onClick = { model.sheet = "time" },
            kind = ChipKind.Dropdown,
            onClear = { set(withTime(f, TimeValue.Any)) },
            clearLabel = Strings.Chips.CLEAR_TIME,
        )
        CaddieChip(
            label = Strings.Chips.group(Strings.Chips.TRACK, f.tracks.toList()),
            active = f.tracks.isNotEmpty(),
            onClick = { model.sheet = "track" },
            kind = ChipKind.Dropdown,
            onClear = { set(f.copy(tracks = emptySet())) },
            clearLabel = Strings.Chips.CLEAR_TRACK,
        )
        if (conference.hasLevel) {
            CaddieChip(
                label = Strings.Chips.group(Strings.Chips.LEVEL, f.levels.toList()),
                active = f.levels.isNotEmpty(),
                onClick = { model.sheet = "level" },
                kind = ChipKind.Dropdown,
                onClear = { set(f.copy(levels = emptySet())) },
                clearLabel = Strings.Chips.CLEAR_LEVEL,
            )
        }
        conference.tagGroups.forEach { group ->
            val selected = f.tags[group].orEmpty()
            val known = tagValues(bundle, group)
            // A group with a single value reads better as a one-tap toggle named after the value.
            val only = known.singleOrNull()?.takeIf { v -> selected.all { it == v } }
            if (only != null) {
                CaddieChip(
                    label = only,
                    active = only in selected,
                    onClick = { set(f.copy(tags = toggleTag(f.tags, group, only))) },
                )
            } else {
                CaddieChip(
                    label = Strings.Chips.group(group, selected.toList()),
                    active = selected.isNotEmpty(),
                    onClick = { model.sheet = "tag:$group" },
                    kind = ChipKind.Dropdown,
                    onClear = { set(f.copy(tags = f.tags - group)) },
                    clearLabel = Strings.Chips.clearGroup(group),
                )
            }
        }
        f.speakers.forEach { name ->
            CaddieChip(
                label = Strings.Chips.speaker(name),
                active = true,
                onClick = { set(f.copy(speakers = f.speakers - name)) },
                kind = ChipKind.Action,
                onClear = { set(f.copy(speakers = f.speakers - name)) },
                clearLabel = Strings.Chips.clearSpeaker(name),
            )
        }
        f.rooms.forEach { name ->
            val label = roomLabel(name)
            CaddieChip(
                label = Strings.Chips.room(label),
                active = true,
                onClick = { set(f.copy(rooms = f.rooms - name)) },
                kind = ChipKind.Action,
                onClear = { set(f.copy(rooms = f.rooms - name)) },
                clearLabel = Strings.Chips.clearRoom(label),
            )
        }
        if (showSlides(f, result)) {
            CaddieChip(
                label = if (f.hasSlides == false) Strings.Chips.NO_SLIDES else Strings.Chips.HAS_SLIDES,
                active = f.hasSlides != null,
                onClick = { set(f.copy(hasSlides = if (f.hasSlides == null) true else null)) },
            )
        }
        CaddieChip(Strings.Chips.HIDE_SPONSOR, f.hideSponsor, { set(f.copy(hideSponsor = !f.hideSponsor)) })
        CaddieChip(Strings.Chips.EVENTS, f.includeEvents, { set(f.copy(includeEvents = !f.includeEvents)) })
        if (model.activeFilterCount > 0) ClearAllButton(model::clearFilters)
    }
}

internal fun toggleTag(tags: Map<String, Set<String>>, group: String, value: String): Map<String, Set<String>> {
    val values = tags[group].orEmpty()
    val next = if (value in values) values - value else values + value
    return if (next.isEmpty()) tags - group else tags + (group to next)
}

/** The last two parts of a room such as "Salt Palace | Level 1 | Hall DE". */
internal fun roomLabel(room: String): String = room.split('|').map { it.trim() }.filter { it.isNotEmpty() }.takeLast(2).joinToString(" · ")
