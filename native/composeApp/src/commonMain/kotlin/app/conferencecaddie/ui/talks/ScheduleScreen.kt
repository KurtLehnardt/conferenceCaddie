package app.conferencecaddie.ui.talks

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.bundle.TalkTime
import app.conferencecaddie.shared.search.SearchRequest
import app.conferencecaddie.shared.search.SearchResult
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.DemoNote
import app.conferencecaddie.ui.components.Hairline
import app.conferencecaddie.ui.components.NoteText
import app.conferencecaddie.ui.components.SegmentOption
import app.conferencecaddie.ui.components.Segmented
import app.conferencecaddie.ui.components.StateAction
import app.conferencecaddie.ui.components.StateView
import app.conferencecaddie.ui.format.Format
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** The Search tab's two views (web app.tsx: "Search | Schedule"). */
enum class SearchView { Search, Schedule }

/**
 * The Search tab: the "Search | Schedule" switch over the two views, as the web's `.view-switch`.
 * [search] and [schedule] draw the views; the tab keeps both models, so each view keeps its state when
 * the other one is shown.
 */
@Composable
fun SearchTab(
    view: SearchView,
    onView: (SearchView) -> Unit,
    search: @Composable () -> Unit,
    schedule: @Composable () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        Segmented(
            options = listOf(
                SegmentOption(SearchView.Search, Strings.Search.VIEW_SEARCH),
                SegmentOption(SearchView.Schedule, Strings.Search.VIEW_SCHEDULE),
            ),
            value = view,
            onChange = onView,
            label = Strings.Search.VIEW_LABEL,
            modifier = Modifier
                .padding(start = Caddie.dimens.gutter, end = Caddie.dimens.gutter, top = 4.dp, bottom = 10.dp)
                .testTag("search-view-switch"),
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (view == SearchView.Search) search() else schedule()
        }
    }
}

/**
 * The full schedule's state (web FullSchedule): the day asked for, the filters (the schedule keeps its
 * own, as the web's `schedFilters`), the result on screen and the filter sheet. It outlives tab
 * switches, and, held by [ScheduleViewModel], a rotation; it resets when the conference changes.
 */
class ScheduleModel(
    private var scope: CoroutineScope,
    private val runSearch: suspend (SearchRequest) -> SearchResult?,
) {
    /** The day the person or a link chose, or null for the default (today while it runs, else the first day). */
    var day by mutableStateOf<String?>(null)

    var filters by mutableStateOf(SearchRequest())
        private set

    var result by mutableStateOf<SearchResult?>(null)
        private set

    var error by mutableStateOf<String?>(null)
        private set

    /** The filter sheet: null when closed, else the section to scroll to ("" for the top). */
    var sheet by mutableStateOf<String?>(null)

    private var slug: String? = null
    private var job: Job? = null
    private var unfinished: String? = null

    /** Runs loads in [newScope] from now on, repeating one the previous scope cut short. */
    fun attach(newScope: CoroutineScope) {
        if (newScope === scope) return
        scope = newScope
        unfinished?.let { load(it) }
    }

    /** Called when the selected conference changes: the day and filters name the old conference's values. */
    fun onConference(newSlug: String?) {
        if (newSlug == slug) return
        slug = newSlug
        day = null
        filters = SearchRequest()
        result = null
        error = null
        sheet = null
    }

    /** The request of [day] with the current filters: the browse mode, without the time filters the day chips replace. */
    fun request(day: String): SearchRequest =
        filters.copy(query = "", day = day, startAfter = null, startBefore = null, happeningNow = false, ignorePhrases = emptySet())

    /** Every talk of [day] that passes the filters, in start order, from the device's bundle. */
    fun load(day: String) {
        job?.cancel()
        unfinished = day
        val request = request(day)
        job = scope.launch {
            try {
                result = runSearch(request)
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                error = Strings.Schedule.UNAVAILABLE
            }
            unfinished = null
        }
    }

    fun updateFilters(next: SearchRequest) {
        filters = next.copy(query = "", day = null, startAfter = null, startBefore = null, happeningNow = false, ignorePhrases = emptySet())
    }

    fun clearFilters() = updateFilters(SearchRequest())

    val activeFilterCount: Int get() = SearchModel.activeFilterCount(filters)
}

/** Holds the [ScheduleModel] for as long as the screen's owner lives, as [SearchViewModel] does. */
class ScheduleViewModel(scope: CoroutineScope, runSearch: suspend (SearchRequest) -> SearchResult?) : ViewModel() {
    val model = ScheduleModel(scope, runSearch)
}

/** Consecutive talks with the same start, in schedule order (web schedule.tsx slots). */
internal data class Slot(val start: String, val talks: List<Talk>)

internal fun slots(talks: List<Talk>): List<Slot> {
    val out = ArrayList<Slot>()
    var current: MutableList<Talk>? = null
    var start: String? = null
    for (t in talks) {
        if (current != null && start == t.start) {
            current += t
        } else {
            current = mutableListOf(t)
            start = t.start
            out += Slot(t.start, current)
        }
    }
    return out
}

/** The slot in progress (started, with a talk still running), else the next one, else the last. */
internal fun nowSlot(list: List<Slot>, nowMs: Long): Int {
    var current = -1
    for ((i, slot) in list.withIndex()) {
        if (slot.talks.first().startEpochMs > nowMs) return if (current != -1) current else i
        if (slot.talks.any { it.endEpochMs > nowMs }) current = i
    }
    return if (current != -1) current else list.lastIndex
}

/** The days with talks, in order: the full schedule's day chips. */
internal fun scheduleDays(bundle: TalkBundle): List<String> = bundle.talks.filter { it.kind == "talk" }.map { it.day }.distinct().sorted()

/**
 * The full schedule (web FullSchedule): the day chips, the filter chips without the time chips (the
 * day chips and Jump to now replace them), the day's count, and the day's talks grouped under their
 * start time, with a star on each. Everything comes from the bundle on the device, so the filters
 * work offline too.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ScheduleScreen(
    model: ScheduleModel,
    bundle: TalkBundle,
    interested: Set<String>,
    nowMs: Long,
    onToggleInterested: (Talk) -> Unit,
    onOpenTalk: (Talk) -> Unit,
) {
    val conference = bundle.conference
    val tz = conference.timeZone
    val days = remember(bundle) { scheduleDays(bundle) }
    val today = ConferenceClock.today(tz, nowMs)
    val running = today in days
    val day = when {
        days.isEmpty() -> null
        model.day in days -> model.day
        running -> today
        else -> days.first()
    }
    val filters = model.filters
    LaunchedEffect(day, filters, bundle.contentHash) { if (day != null) model.load(day) }
    val shown = model.result?.takeIf { day != null && it.request == model.request(day) }
    val list = shown?.let { slots(it.talks) }.orEmpty()
    val listState = rememberLazyListState()
    var jump by remember { mutableStateOf(false) }
    // Jump to now, once today's talks are on screen: the slot in progress, else the next one.
    LaunchedEffect(jump, shown) {
        if (!jump || shown == null || day != today) return@LaunchedEffect
        jump = false
        if (list.isNotEmpty()) listState.animateScrollToItem(HEADER_ITEMS + 2 * nowSlot(list, nowMs))
    }
    val c = Caddie.colors

    LazyColumn(
        Modifier.fillMaxSize().testTag("schedule-screen"),
        state = listState,
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        item("days") {
            // A demo conference's note scrolls with the schedule, inside its first item so the
            // items keep the indices the jump to now counts on (HEADER_ITEMS).
            Column(Modifier.fillMaxWidth()) {
                DemoNote(conference.demo, Modifier.padding(start = Caddie.dimens.gutter, end = Caddie.dimens.gutter, bottom = 8.dp))
                DayChips(days, day, onChange = { model.day = it }, today = today.takeIf { running })
            }
        }
        item("chips") {
            FilterChips(
                filters = filters,
                activeCount = model.activeFilterCount,
                result = shown,
                bundle = bundle,
                onChange = model::updateFilters,
                onSheet = { model.sheet = it },
                onClearAll = model::clearFilters,
                schedule = true,
            )
        }
        item("header") {
            // .results-header: the day's count and Jump to now while the conference runs.
            Row(
                Modifier.fillMaxWidth().padding(start = Caddie.dimens.gutter, end = Caddie.dimens.gutter, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    if (day != null && shown != null) Strings.Schedule.count(Format.day(day), shown.total, filters.includeEvents) else Strings.Schedule.LOADING,
                    style = Caddie.type.meta.copy(fontWeight = FontWeight.Medium),
                    color = c.text2,
                    modifier = Modifier.weight(1f).testTag("schedule-count").semantics { liveRegion = LiveRegionMode.Polite },
                )
                if (running) {
                    CaddieButton(
                        Strings.Schedule.JUMP_TO_NOW,
                        onClick = {
                            if (day != today) model.day = today
                            jump = true
                        },
                        variant = ButtonVariant.Tonal,
                        small = true,
                        icon = LucideIcon.Clock,
                        iconSize = 16.dp,
                        modifier = Modifier.testTag("jump-to-now"),
                    )
                }
            }
        }
        val error = model.error
        when {
            days.isEmpty() -> item("empty") {
                StateView(icon = LucideIcon.SearchX, body = Strings.Schedule.NO_TALKS)
            }
            shown == null && error != null -> item("error") {
                StateView(
                    Modifier.testTag("schedule-error"),
                    icon = LucideIcon.CircleExclamationPoint,
                    title = Strings.Blockers.SOMETHING_WRONG,
                    body = error,
                    action = StateAction(Strings.Common.RETRY, { day?.let(model::load) }),
                )
            }
            shown == null -> item("skeleton") { SkeletonRows() }
            shown.talks.isEmpty() -> item("none") {
                StateView(
                    icon = LucideIcon.SearchX,
                    body = Strings.Schedule.NOTHING_MATCHES,
                    action = if (model.activeFilterCount > 0) StateAction(Strings.Search.CLEAR_ALL_FILTERS, model::clearFilters) else null,
                )
            }
            else -> {
                list.forEachIndexed { i, slot ->
                    stickyHeader("slot-${slot.start}") {
                        // .sched-time: the start, sticking under the app bar while its talks scroll.
                        Text(
                            Format.time(slot.talks.first().startMinutes),
                            style = Caddie.type.meta.copy(fontWeight = FontWeight.Bold),
                            color = c.text2,
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(c.bg)
                                .padding(horizontal = Caddie.dimens.gutter, vertical = 8.dp)
                                .testTag("slot-$i")
                                .semantics { heading() },
                        )
                    }
                    item("list-${slot.start}") {
                        ScheduleList(Modifier.padding(bottom = 12.dp)) {
                            slot.talks.forEachIndexed { j, talk ->
                                if (j > 0) Hairline()
                                ScheduleRow(talk, talk.talkId in interested, onToggleInterested, onOpenTalk)
                            }
                        }
                    }
                }
                item("footnote") {
                    NoteText(
                        Strings.Schedule.footnote(TalkTime.zoneLabel(tz, list.first().start)),
                        Modifier.padding(top = 12.dp).testTag("schedule-footnote"),
                        center = true,
                    )
                }
            }
        }
    }
    if (model.sheet != null) {
        FilterSheet(
            conference = conference,
            bundle = bundle,
            filters = filters,
            result = shown,
            onChange = model::updateFilters,
            onClose = { model.sheet = null },
            schedule = true,
        )
    }
}

/** The items above the first slot: the day chips, the filter chips and the count. */
private const val HEADER_ITEMS = 3

/** The full schedule's skeleton: four rows of grey bars in a card. */
@Composable
private fun SkeletonRows() {
    val c = Caddie.colors
    ScheduleList(Modifier.testTag("schedule-skeleton")) {
        repeat(4) { i ->
            if (i > 0) Hairline()
            Column(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 10.dp)) {
                Box(Modifier.fillMaxWidth(0.75f).height(18.dp).padding(top = 4.dp).clip(RoundedCornerShape(6.dp)).background(c.fill))
                Box(Modifier.fillMaxWidth(0.4f).padding(top = 10.dp).height(12.dp).clip(RoundedCornerShape(6.dp)).background(c.fill))
            }
        }
    }
}
