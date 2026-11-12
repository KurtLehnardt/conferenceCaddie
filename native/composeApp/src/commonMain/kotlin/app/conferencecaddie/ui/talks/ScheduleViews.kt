package app.conferencecaddie.ui.talks

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.components.Pill
import app.conferencecaddie.ui.components.caddieClickable
import app.conferencecaddie.ui.format.Format
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.minimumTouchTarget
import kotlin.math.max
import kotlin.math.min
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

// The schedule views of web/src/components/schedule.tsx: the day chips, My schedule's Day timeline
// and the full schedule's rows. These are views only: talks at the same time sit side by side with
// no warning, and nothing is planned for the person.

/** The conference's local clock (web/src/lib/time.ts todayIn and minutesInDay). */
internal object ConferenceClock {
    private fun zone(timeZone: String?): TimeZone =
        timeZone?.let { runCatching { TimeZone.of(it) }.getOrNull() } ?: TimeZone.UTC

    /** Today's date, "YYYY-MM-DD", in the conference's time zone. */
    fun today(timeZone: String?, nowMs: Long): String =
        Instant.fromEpochMilliseconds(nowMs).toLocalDateTime(zone(timeZone)).date.toString()

    /** Minutes after local midnight now, in the conference's time zone. */
    fun minutes(timeZone: String?, nowMs: Long): Int =
        Instant.fromEpochMilliseconds(nowMs).toLocalDateTime(zone(timeZone)).let { it.hour * 60 + it.minute }
}

/**
 * .day-chips: one chip per day as a radio group, scrolling sideways, with "Today" on today's chip.
 * The chosen chip is kept in view.
 */
@Composable
internal fun DayChips(
    days: List<String>,
    value: String?,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    today: String? = null,
) {
    val scroll = rememberScrollState()
    val positions = remember(days) { HashMap<String, Pair<Int, Int>>() }
    val density = LocalDensity.current
    val gutterDp = Caddie.dimens.gutter
    LaunchedEffect(value, days) {
        val (x, w) = positions[value] ?: return@LaunchedEffect
        val gutter = with(density) { gutterDp.roundToPx() }
        val view = scroll.viewportSize
        when {
            x - gutter < scroll.value -> scroll.animateScrollTo(max(0, x - gutter))
            x + w + gutter > scroll.value + view -> scroll.animateScrollTo(min(scroll.maxValue, x + w + gutter - view))
        }
    }
    Row(
        modifier
            .fillMaxWidth()
            .horizontalScroll(scroll)
            .padding(start = Caddie.dimens.gutter, end = Caddie.dimens.gutter, top = 4.dp, bottom = 12.dp)
            .selectableGroup()
            .semantics { isTraversalGroup = true }
            .testTag("day-chips"),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        days.forEach { d ->
            DayChip(
                label = Format.day(d),
                on = d == value,
                today = d == today,
                onClick = { onChange(d) },
                modifier = Modifier
                    .testTag("day-chip-$d")
                    .onGloballyPositioned { positions[d] = it.positionInParent().x.toInt() to it.size.width },
            )
        }
    }
}

/** .chip.day-chip: the day and, on today's chip, the "Today" pill. */
@Composable
private fun DayChip(label: String, on: Boolean, today: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Caddie.colors
    Row(
        modifier
            .minimumTouchTarget()
            .heightIn(min = Caddie.dimens.chipHeight)
            .clip(Pill)
            .background(if (on) c.accentTint else c.surface, Pill)
            .then(if (on) Modifier else Modifier.border(1.dp, c.borderStrong, Pill))
            .selectable(selected = on, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(label, style = Caddie.type.chip, color = if (on) c.accentInk else c.text, maxLines = 1)
        if (today) {
            Text(
                Strings.Schedule.TODAY,
                style = Caddie.type.badge.copy(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
                color = if (on) c.accentInk else c.text2,
                maxLines = 1,
                modifier = Modifier
                    .background(if (on) c.surface else c.fill, Pill)
                    .padding(horizontal = 6.dp, vertical = 1.dp),
            )
        }
    }
}

/** A talk placed on the Day timeline: its offset and height from the top, and its column. */
internal data class Placed(val talk: Talk, val top: Dp, val height: Dp, val col: Int, val cols: Int)

internal data class Timeline(val placed: List<Placed>, val from: Int, val to: Int)

/** The web's 2 px per minute, so a 30-minute talk is 60 dp tall. */
internal val PER_MINUTE = 2.dp

/** A card is its slot's height less a 2 dp gap, and never under the 44 dp tap target. */
internal val MIN_CARD = 46.dp

/**
 * Places a day's marked talks on a timeline, as the web's place() does: talks whose times overlap
 * share the width in equal columns, side by side. Layout only: nothing is flagged or removed. A talk
 * that runs past midnight is drawn to the end of its day.
 */
internal fun place(talks: List<Talk>): Timeline {
    val minCardMinutes = MIN_CARD.value / PER_MINUTE.value
    class Span(val talk: Talk, val start: Int, val end: Float)
    val spans = talks.map { t ->
        val endRaw = if (t.end.take(10) == t.day) t.endMinutes.coerceAtMost(24 * 60) else 24 * 60
        Span(t, t.startMinutes, max(endRaw.toFloat(), t.startMinutes + minCardMinutes))
    }
    if (spans.isEmpty()) return Timeline(emptyList(), 0, 0)
    val from = spans.minOf { it.start } / 60 * 60
    val to = min(24 * 60, kotlin.math.ceil(spans.maxOf { it.end } / 60.0).toInt() * 60)
    val placed = ArrayList<Placed>()
    var group = ArrayList<Pair<Span, Int>>()
    var groupEnd = -1f
    var columnEnds = ArrayList<Float>()
    fun flush() {
        for ((span, col) in group) {
            placed += Placed(
                talk = span.talk,
                top = PER_MINUTE * (span.start - from),
                height = max(MIN_CARD.value, (span.end - span.start) * PER_MINUTE.value).dp,
                col = col,
                cols = columnEnds.size,
            )
        }
        group = ArrayList()
        columnEnds = ArrayList()
    }
    for (span in spans) {
        if (span.start >= groupEnd) {
            flush()
            groupEnd = -1f
        }
        var col = columnEnds.indexOfFirst { it <= span.start }
        if (col == -1) {
            col = columnEnds.size
            columnEnds += span.end
        } else {
            columnEnds[col] = span.end
        }
        group += span to col
        groupEnd = max(groupEnd, span.end)
    }
    flush()
    return Timeline(placed, from, to)
}

/**
 * .tl: a vertical timeline of one day's marked talks ([talks] in start order), with an hour gutter
 * and, today, a "Now" line in the danger colour.
 */
@Composable
internal fun DayTimeline(
    talks: List<Talk>,
    day: String,
    timeZone: String?,
    nowMs: Long,
    onOpenTalk: (Talk) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (talks.isEmpty()) return
    val c = Caddie.colors
    val t = place(talks)
    // The "Now" line, on today's timeline while now is within its hours.
    val nowMin = if (ConferenceClock.today(timeZone, nowMs) == day) ConferenceClock.minutes(timeZone, nowMs).takeIf { it in t.from..t.to } else null
    val gutterLabel = 46.dp
    val eventsLeft = 50.dp
    Box(
        modifier
            .fillMaxWidth()
            .padding(start = Caddie.dimens.gutter, end = Caddie.dimens.gutter, top = 12.dp, bottom = 20.dp)
            .height(PER_MINUTE * (t.to - t.from) + 16.dp)
            .testTag("day-timeline")
            // The day's cards are read in order as one group; the chosen day chip names the day.
            .semantics { isTraversalGroup = true },
    ) {
        // The hour lines and labels, which screen readers skip as the web marks them aria-hidden.
        for (m in t.from..t.to step 60) {
            val top = PER_MINUTE * (m - t.from)
            Box(
                Modifier
                    .fillMaxWidth()
                    .offset(y = top)
                    .height(1.dp)
                    .background(c.border)
                    .clearAndSetSemantics { },
            )
            Text(
                Format.hour(m / 60),
                style = Caddie.type.tag.copy(fontWeight = FontWeight.Normal, lineHeight = 16.sp),
                color = c.text2,
                maxLines = 1,
                modifier = Modifier
                    .offset(y = top - 8.dp)
                    .width(gutterLabel)
                    .background(c.bg)
                    .padding(end = 6.dp)
                    .clearAndSetSemantics { },
            )
        }
        BoxWithConstraints(Modifier.padding(start = eventsLeft).fillMaxWidth().fillMaxHeight().semantics { isTraversalGroup = true }) {
            val width = maxWidth
            t.placed.forEach { p ->
                TimelineCard(
                    p,
                    onClick = { onOpenTalk(p.talk) },
                    modifier = Modifier
                        .offset(x = width * p.col / p.cols, y = p.top)
                        .width(width / p.cols)
                        .height(p.height),
                )
            }
        }
        if (nowMin != null) {
            val top = PER_MINUTE * (nowMin - t.from)
            Box(
                Modifier
                    .padding(start = 44.dp)
                    .fillMaxWidth()
                    .offset(y = top - 1.dp)
                    .height(2.dp)
                    .drawBehind {
                        drawRect(c.danger)
                        drawCircle(c.danger, radius = 4.dp.toPx(), center = Offset(0f, size.height / 2))
                    }
                    .clearAndSetSemantics { }
                    .testTag("timeline-now"),
            )
            // .tl-now-label: the pill ends 6 dp before the line, in the hour gutter.
            Box(Modifier.offset(y = top - 8.dp).width(38.dp), contentAlignment = Alignment.CenterEnd) {
                Text(
                    Strings.Schedule.NOW,
                    style = Caddie.type.badge.copy(fontSize = 11.sp, lineHeight = 16.sp),
                    color = c.surface,
                    maxLines = 1,
                    modifier = Modifier
                        .background(c.danger, Pill)
                        .padding(horizontal = 6.dp)
                        .clearAndSetSemantics { },
                )
            }
        }
    }
}

/** .tl-item and .tl-card: the title over as many lines as fit, then the time and room. */
@Composable
private fun TimelineCard(p: Placed, onClick: () -> Unit, modifier: Modifier) {
    val c = Caddie.colors
    val shape = RoundedCornerShape(8.dp)
    val fontScale = LocalDensity.current.fontScale
    // The web fits (height - 32) / 18 lines of title; at a larger font size each line is taller.
    val lines = max(1, ((p.height.value - 32 * fontScale) / (18 * fontScale)).toInt())
    val meta = Format.timeRange(p.talk.startMinutes, p.talk.endMinutes) + (p.talk.room?.let { " · $it" } ?: "")
    Box(modifier.padding(start = 2.dp, end = 2.dp, bottom = 2.dp).testTag("timeline-${p.talk.talkId}")) {
        Column(
            Modifier
                .fillMaxWidth()
                .fillMaxHeight()
                .clip(shape)
                .background(c.surface)
                .background(c.accentTint)
                .drawBehind { drawRect(c.accent, size = Size(3.dp.toPx(), size.height)) }
                .caddieClickable(shape, onClick = onClick)
                .padding(start = 11.dp, end = 8.dp, top = 5.dp, bottom = 5.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                p.talk.title,
                style = Caddie.type.cardTitle.copy(fontSize = 13.sp, lineHeight = 18.sp),
                color = c.text,
                maxLines = lines,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                meta,
                style = Caddie.type.tag.copy(fontWeight = FontWeight.Normal, lineHeight = 16.sp),
                color = c.text2,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * .sched-row: a talk of the full schedule, the title, speakers and room · track opening it, and the
 * star marking it Interested. An event or showcase has its label and no star.
 */
@Composable
internal fun ScheduleRow(
    talk: Talk,
    interested: Boolean,
    onToggle: (Talk) -> Unit,
    onOpen: (Talk) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Caddie.colors
    val event = talk.kind == "ambient"
    val meta = listOfNotNull(talk.room, talk.track?.takeIf { it.isNotEmpty() && it != "Not specified" }).filter { it.isNotEmpty() }.joinToString(" · ")
    Row(
        modifier.fillMaxWidth().padding(end = 4.dp).testTag("sched-${talk.talkId}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Column(
            Modifier
                .weight(1f)
                .heightIn(min = 56.dp)
                .caddieClickable(RoundedCornerShape(0.dp)) { onOpen(talk) }
                .padding(start = 14.dp, end = 6.dp, top = 10.dp, bottom = 10.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            if (event) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    LucideImage(LucideIcon.CalendarDays, null, size = 12.dp)
                    Text(Strings.Schedule.EVENT, style = Caddie.type.tag.copy(fontWeight = FontWeight.SemiBold), color = c.text2)
                }
            }
            Text(talk.title, style = Caddie.type.cardTitle.copy(fontSize = 15.sp, lineHeight = 19.5.sp), color = c.text)
            if (talk.speakers.isNotEmpty()) {
                Text(talk.speakers.joinToString(", "), style = Caddie.type.note.copy(lineHeight = 17.5.sp), color = c.text2)
            }
            if (meta.isNotEmpty()) Text(meta, style = Caddie.type.note.copy(lineHeight = 17.5.sp), color = c.text2)
        }
        if (!event) {
            Box(
                Modifier
                    .minimumTouchTarget()
                    .size(Caddie.dimens.minTouch)
                    .caddieClickable(CircleShape, role = Role.Checkbox) { onToggle(talk) }
                    .semantics {
                        contentDescription = Strings.Schedule.interested(talk.title)
                        toggleableState = ToggleableState(interested)
                        stateDescription = if (interested) "Interested" else "Not interested"
                    }
                    .testTag("sched-star-${talk.talkId}"),
                contentAlignment = Alignment.Center,
            ) {
                LucideImage(LucideIcon.Star, null, size = 22.dp, tint = if (interested) c.accent else c.text2, filled = interested)
            }
        }
    }
}

/** .sched-list: the rows of one start time in a bordered card, with hairlines between them. */
@Composable
internal fun ScheduleList(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val c = Caddie.colors
    val shape = RoundedCornerShape(Caddie.dimens.radius)
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = Caddie.dimens.gutter)
            .then(if (c.cardShadow) Modifier.shadow(1.dp, shape, ambientColor = c.border, spotColor = c.border) else Modifier)
            .clip(shape)
            .background(c.surface)
            .border(1.dp, c.border, shape),
    ) { content() }
}
