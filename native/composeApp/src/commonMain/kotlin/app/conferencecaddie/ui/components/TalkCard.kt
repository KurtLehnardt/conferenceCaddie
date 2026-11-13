package app.conferencecaddie.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.shell.isWebLink
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.minimumTouchTarget

/** A link at the bottom of a talk card (.card-links). Only http(s) URLs are ever opened. */
data class CardLink(val label: String, val icon: LucideIcon, val url: String)

/**
 * .card: one talk, as the web's TalkCard draws it. Every field is plain text, so the card knows
 * nothing about where the talk came from:
 * - [title] (two lines at most), [speakers] (names joined with ", "), [whenText] ("Tue, Nov 10 ·
 *   9:00–9:30 AM CST"), [room], and [tags] (track, level and tag values, placeholders left out);
 * - [evidence], the matched passage with [highlight] marks;
 * - [interested] and [onToggleInterested] for the "I'm interested" button, which reads "I was there /
 *   wanted to be" once [ended];
 * - [isEvent] draws the dashed card of a co-located event or showcase, which has no interest button;
 * - [links] at the bottom, opened through [onOpenLink]; only http(s) links are shown, so
 *   [onOpenLink] never receives another scheme; [onClick] makes the whole card open the talk;
 * - [extra] is drawn under the actions (related talks, for example);
 * - [demo] puts the Demo pill at the very top of the card, for a talk of a demo conference.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TalkCard(
    title: String,
    whenText: String,
    modifier: Modifier = Modifier,
    speakers: String? = null,
    room: String? = null,
    tags: List<String> = emptyList(),
    evidence: AnnotatedString? = null,
    interested: Boolean = false,
    onToggleInterested: (() -> Unit)? = null,
    ended: Boolean = false,
    isEvent: Boolean = false,
    links: List<CardLink> = emptyList(),
    onOpenLink: (String) -> Unit = {},
    onClick: (() -> Unit)? = null,
    flat: Boolean = false,
    extra: (@Composable ColumnScope.() -> Unit)? = null,
    demo: Boolean = false,
) {
    val c = Caddie.colors
    val d = Caddie.dimens
    val shape = RoundedCornerShape(d.radius)
    val base = if (flat) {
        modifier.fillMaxWidth()
    } else {
        modifier
            .fillMaxWidth()
            .then(if (c.cardShadow && !isEvent) Modifier.shadow(1.dp, shape, ambientColor = c.border, spotColor = c.border) else Modifier)
            .background(if (isEvent) c.accentTint else c.surface, shape)
            .border(1.dp, if (isEvent) c.borderStrong else c.border, shape)
            .then(if (onClick != null) Modifier.caddieClickable(shape, onClick = onClick) else Modifier)
            .padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 8.dp)
    }
    Column(base) {
        if (showsDemoLabel(demo)) DemoPill(Modifier.padding(bottom = 6.dp))
        if (isEvent) {
            Row(
                Modifier.background(c.surface, Pill).padding(horizontal = 8.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                LucideImage(LucideIcon.CalendarDays, null, size = 14.dp, tint = c.accentInk)
                Text(Strings.Talk.EVENT_BADGE, style = Caddie.type.navLabel.copy(fontWeight = Caddie.type.cardTitle.fontWeight), color = c.accentInk)
            }
        }
        Text(
            title,
            style = Caddie.type.cardTitle,
            color = c.text,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 2.dp).semantics { heading() },
        )
        if (!isEvent && !speakers.isNullOrEmpty()) {
            Text(speakers, style = Caddie.type.meta, color = c.text2, modifier = Modifier.padding(top = 2.dp))
        }
        FlowRow(
            Modifier.padding(top = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            MetaItem(LucideIcon.Clock, whenText)
            if (!room.isNullOrEmpty()) MetaItem(LucideIcon.MapPin, room)
        }
        if (tags.isNotEmpty()) {
            FlowRow(
                Modifier.padding(top = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                tags.forEach { Tag(it) }
            }
        }
        if (evidence != null && evidence.isNotEmpty()) {
            Text(evidence, style = Caddie.type.meta, color = c.text2, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 10.dp))
        }
        if (!isEvent && onToggleInterested != null) {
            Row(Modifier.padding(top = 12.dp)) { InterestedToggle(interested, ended, onToggleInterested) }
        }
        extra?.invoke(this)
        // A link the apps would not open (any scheme but http and https) is not shown at all.
        val webLinks = links.filter { isWebLink(it.url) }
        if (webLinks.isNotEmpty()) {
            FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                webLinks.forEach { link -> LinkButton(link.label, link.icon) { if (isWebLink(link.url)) onOpenLink(link.url) } }
            }
        }
    }
}

/** .meta-item: a 16 dp icon and secondary text. */
@Composable
fun MetaItem(icon: LucideIcon, text: String, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        LucideImage(icon, null, size = 16.dp)
        Text(text, style = Caddie.type.meta, color = Caddie.colors.text2)
    }
}

/** .tag: a small pill on the fill colour. */
@Composable
fun Tag(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = Caddie.type.tag,
        color = Caddie.colors.text2,
        modifier = modifier.background(Caddie.colors.fill, Pill).padding(horizontal = 10.dp, vertical = 2.dp),
    )
}

/**
 * .interest-btn: the "I'm interested" toggle, with a star that fills when on. Screen readers hear a
 * checkbox that is checked or not (the web's aria-pressed).
 */
@Composable
fun InterestedToggle(on: Boolean, ended: Boolean, onToggle: () -> Unit, modifier: Modifier = Modifier) {
    val c = Caddie.colors
    val label = if (ended) Strings.Talk.WAS_THERE else Strings.Talk.INTERESTED
    val interaction = remember { MutableInteractionSource() }
    Row(
        modifier
            .minimumTouchTarget()
            .heightIn(min = Caddie.dimens.minTouch)
            .focusRing(interaction, Pill)
            .clip(Pill)
            .toggleable(value = on, interactionSource = interaction, indication = ripple(), role = Role.Checkbox, onValueChange = { onToggle() })
            .background(if (on) c.accentTint else androidx.compose.ui.graphics.Color.Transparent, Pill)
            .then(if (on) Modifier else Modifier.border(1.dp, c.borderStrong, Pill))
            .padding(start = 12.dp, end = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LucideImage(LucideIcon.Star, null, size = 18.dp, tint = if (on) c.accent else c.text2, filled = on)
        Text(label, style = Caddie.type.buttonSmall, color = if (on) c.accentInk else c.text)
    }
}

/**
 * .link: an accent text link with an icon, at least 44 dp tall, with the platform's minimum touch
 * target. It runs [onClick]; a caller that opens a URL with it checks the URL first (see [TalkCard]).
 */
@Composable
fun LinkButton(text: String, icon: LucideIcon?, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Row(
        modifier
            .minimumTouchTarget()
            .heightIn(min = Caddie.dimens.minTouch)
            .caddieClickable(RoundedCornerShape(6.dp), role = Role.Button, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (icon != null) LucideImage(icon, null, size = 16.dp, tint = Caddie.colors.accentInk)
        Text(text, style = Caddie.type.buttonSmall, color = Caddie.colors.accentInk)
    }
}

/**
 * [text] with every case-insensitive occurrence of [terms] marked as the web marks matches (mark:
 * --mark-bg behind --mark-text).
 */
@Composable
fun highlight(text: String, terms: List<String>): AnnotatedString {
    val c = Caddie.colors
    val words = terms.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
    if (words.isEmpty()) return AnnotatedString(text)
    val lower = text.lowercase()
    val marks = BooleanArray(text.length)
    for (w in words) {
        val lw = w.lowercase()
        var i = lower.indexOf(lw)
        while (i >= 0) {
            for (k in i until minOf(text.length, i + lw.length)) marks[k] = true
            i = lower.indexOf(lw, i + lw.length)
        }
    }
    return buildAnnotatedString {
        var i = 0
        while (i < text.length) {
            val on = marks[i]
            var j = i
            while (j < text.length && marks[j] == on) j++
            if (on) withStyle(SpanStyle(background = c.markBg, color = c.markText)) { append(text.substring(i, j)) } else append(text.substring(i, j))
            i = j
        }
    }
}
