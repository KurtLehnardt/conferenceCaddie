package app.conferencecaddie.ui.talks

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.snapping.SnapLayoutInfoProvider
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.unit.sp
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkTime
import app.conferencecaddie.shared.search.ForYou
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.components.caddieClickable
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.people.ErrorText
import app.conferencecaddie.ui.people.HintText
import app.conferencecaddie.ui.people.RefreshBar
import app.conferencecaddie.ui.people.SectionHead
import app.conferencecaddie.ui.people.refreshing
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.roundToInt

/**
 * The For you row of the People home (web ForYouRow in web/src/people/ForYou.tsx): the title "For
 * you" with "See all" ([onSeeAll], the For you tab) once there are suggestions, then the first
 * [ForYouModel.ROW_SIZE] suggestions of [model] as small cards in a row that scrolls sideways and
 * stops at a card's edge. A card shows the title (three lines at most), the day and time, and "Learn:"
 * with at most two of the learn topics it matched, and opens the talk ([onOpenTalk]). With nothing to
 * suggest from it is For you's "Pick what you want to learn" prompt ([onPickTopics]); otherwise
 * "Finding talks…", the error, "No upcoming talks…" or the keyword-match note, as the web words them.
 * While a new list is worked out the earlier one stays, dimmed, with the progress bar under the
 * title. For you runs on the device, so this row is drawn by the talk screens and handed to the
 * People tab through [app.conferencecaddie.ui.people.PeopleTalks.forYouRow].
 */
@Composable
fun ForYouRow(
    model: ForYouModel,
    onOpenTalk: (Talk) -> Unit,
    onSeeAll: () -> Unit,
    onPickTopics: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val r = model.result
    val ready = r as? ForYou.Result.Ready
    val items = ready?.items.orEmpty().take(ForYouModel.ROW_SIZE)
    // .pp-section: the head, then each block 10 dp below the one before.
    Column(modifier.fillMaxWidth().testTag("for-you-row"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // .pp-section-head.pp-progress-host: the bar sits on the head's bottom edge and takes no room.
        Box(Modifier.fillMaxWidth()) {
            SectionHead(
                Strings.ForYou.ROW_TITLE,
                Modifier.testTag("for-you-row-title"),
                trailing = if (items.isNotEmpty()) {
                    { SeeAllLink(onSeeAll) }
                } else {
                    null
                },
            )
            RefreshBar(model.refreshing && items.isNotEmpty(), Modifier.align(Alignment.BottomCenter).offset(y = 6.dp))
        }
        when {
            r == ForYou.Result.NeedsInput -> PickTopicsPrompt(onPickTopics)
            r == null && model.error == null -> HintText(Strings.ForYou.FINDING, pad = true)
        }
        model.error?.let { ErrorText(it, Modifier.testTag("for-you-row-error"), pad = true) }
        if (ready != null) {
            if (ready.items.isEmpty()) HintText(Strings.ForYou.NONE, pad = true)
            if (ready.degraded) {
                HintText(Strings.ForYou.DEGRADED_NATIVE, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, pad = true)
            }
        }
        if (items.isNotEmpty()) MiniCards(items, model.refreshing, onOpenTalk)
    }
}

/** .pp-see-all: "See all" and a chevron, accent ink 15/600, 44 dp tall, 4 dp in at each side. */
@Composable
private fun SeeAllLink(onClick: () -> Unit) {
    val c = Caddie.colors
    Row(
        Modifier
            .heightIn(min = Caddie.dimens.minTouch)
            .caddieClickable(RoundedCornerShape(6.dp), onClick = onClick)
            .padding(horizontal = 4.dp)
            .testTag("for-you-see-all"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(Strings.ForYou.SEE_ALL, style = Caddie.type.button, color = c.accentInk)
        LucideImage(LucideIcon.ChevronRight, null, size = 16.dp, tint = c.accentInk)
    }
}

/**
 * .pp-row: the cards side by side, 10 dp apart, the row as wide as the screen (it reaches out over
 * the gutters) with the gutter as padding, 2 dp above and 6 below for the shadow. Each card is 78%
 * of the width inside the gutters, at most 280 dp, and as tall as the tallest. A fling stops with a
 * card at the left gutter, as scroll-snap does on the web.
 */
@Composable
private fun MiniCards(items: List<ForYou.Item>, dimmed: Boolean, onOpenTalk: (Talk) -> Unit) {
    val gutter = Caddie.dimens.gutter
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val cardWidth = min(maxWidth * 0.78f, 280.dp)
        val gap = 10.dp
        val scroll = rememberScrollState()
        val pitch = with(LocalDensity.current) { (cardWidth + gap).toPx() }
        val snap = remember(scroll, pitch) { CardSnap(scroll, pitch) }
        Row(
            Modifier
                .wideBy(gutter)
                .horizontalScroll(scroll, flingBehavior = rememberSnapFlingBehavior(snap))
                .height(IntrinsicSize.Min)
                .padding(start = gutter, end = gutter, top = 2.dp, bottom = 6.dp)
                .refreshing(dimmed)
                .testTag("for-you-row-cards"),
            horizontalArrangement = Arrangement.spacedBy(gap),
        ) {
            items.forEach { item -> MiniCard(item, cardWidth) { onOpenTalk(item.talk) } }
        }
    }
}

/** Lays the content out [by] wider at each side than the space it was given, so it reaches the screen's edges. */
private fun Modifier.wideBy(by: Dp): Modifier = layout { measurable, constraints ->
    val extra = (by * 2).roundToPx()
    val wide = constraints.maxWidth + extra
    val placeable = measurable.measure(constraints.copy(minWidth = wide, maxWidth = wide))
    layout(constraints.maxWidth, placeable.height) { placeable.place(-extra / 2, 0) }
}

/** Stops a fling with a card's left edge at the gutter: the next card in the fling's direction, or the nearest. */
private class CardSnap(private val scroll: ScrollState, private val pitch: Float) : SnapLayoutInfoProvider {
    override fun calculateApproachOffset(velocity: Float, decayOffset: Float): Float = 0f

    override fun calculateSnapOffset(velocity: Float): Float {
        val at = scroll.value / pitch
        val card = when {
            velocity > 0f -> ceil(at)
            velocity < 0f -> floor(at)
            else -> at.roundToInt().toFloat()
        }
        return (card * pitch).coerceIn(0f, scroll.maxValue.toFloat()) - scroll.value
    }
}

/**
 * .pp-mini: a bordered surface card with the small shadow, padding 14, at least 132 dp tall, its
 * lines 6 dp apart: the title (16/600, line height 1.3, three lines at most), the day and time (13,
 * secondary) and the reason (13/600, accent ink, two lines at most). The whole card is a button.
 */
@Composable
private fun MiniCard(item: ForYou.Item, width: Dp, onOpen: () -> Unit) {
    val c = Caddie.colors
    val t = item.talk
    val shape = RoundedCornerShape(Caddie.dimens.radius)
    val why = item.learnTopics.take(2).takeIf { it.isNotEmpty() }?.let { Strings.ForYou.rowWhy(it) }
    Column(
        Modifier
            .width(width)
            .fillMaxHeight()
            .heightIn(min = 132.dp)
            .then(if (c.cardShadow) Modifier.shadow(1.dp, shape, ambientColor = c.border, spotColor = c.border) else Modifier)
            .background(c.surface, shape)
            .border(1.dp, c.border, shape)
            .caddieClickable(shape, onClick = onOpen)
            .padding(14.dp)
            .testTag("for-you-mini-${t.talkId}"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            t.title,
            style = Caddie.type.cardTitle.copy(fontSize = 16.sp, lineHeight = (16 * 1.3f).sp, fontWeight = FontWeight.SemiBold),
            color = c.text,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        Text("${TalkTime.day(t.day)} · ${TalkTime.time(t.startMinutes)}", style = Caddie.type.note, color = c.text2)
        if (why != null) {
            Text(
                why,
                style = Caddie.type.note.copy(fontWeight = FontWeight.SemiBold),
                color = c.accentInk,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
