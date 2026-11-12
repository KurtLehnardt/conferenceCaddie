package app.conferencecaddie.ui.people

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.people.MeetState
import app.conferencecaddie.shared.people.PeoplePrivacy
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.shared.people.Person
import app.conferencecaddie.shared.people.ReportKind
import app.conferencecaddie.shared.people.TopicRef
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.Hairline
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.components.caddieClickable
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.theme.Caddie
import kotlinx.coroutines.launch

/**
 * A person (web PersonCard.tsx, spec section 4), on the People home and in U1's talk circles: a
 * [PersonFrame] (dashed and quiet when `person.broad`) with, top to bottom:
 *
 * - the header: the name (17/600 at a line height of 1.3; 500 and secondary on a broad card), the
 *   [SamplePill], and the [OverflowMenu] "Options for {name}" with Report (`host.report`, a profile
 *   report) and a destructive Block (`host.confirmBlock`), pulled 10 dp into the card's padding;
 * - on a broad card, the broad line: the server's "Also interested in …" reason with the people icon;
 * - while they are around, the [AroundLine]: "Around · {zone}" or "Around now" and the band pill, the
 *   zone and the band read through [PeoplePrivacy] only, so neither shows unless I am around too,
 *   and never a distance;
 * - about, the evidence quote (not on a broad card), the opener ([OpenerBox], unless it repeats the
 *   evidence), the other reasons, "Can speak to:" and "Wants to learn:" (six topics, then "and {n}
 *   more"), and How to reach me (a LinkedIn link, opened through `host.openUrl` only for an https
 *   linkedin.com address, and the contact note);
 * - one action, in the web's priority: "Waved" (`host.hasWaved`) or "No reply yet" while my ask
 *   waits (`state.inbox.askStates`); "Open meet-up" for an open meet with them; "Wave" when they are
 *   in my zone (U3's [sendWave], "Waving…" meanwhile); "Ask to talk shop" while they are around
 *   (`host.ask`); else the watch toggle "Tell me when they're around" / "Watching".
 *
 * The backend's capabilities hide what it does not offer: no ask, wave or meet without meets, no
 * watch toggle without presence (a watch only ever nudges while I am around), no Report without
 * reports. [revealed] rings the card for "See who". The card never shows a spot line or a distance,
 * whatever the server sent. Owner U2.
 */
@Composable
fun PersonCard(
    person: Person,
    state: PeopleUiState,
    host: PeopleHost,
    modifier: Modifier = Modifier,
    revealed: Boolean = false,
) {
    val c = Caddie.colors
    val broad = person.broad
    val evidence = person.evidence?.let(PeopleText::plainText).orEmpty()
    // The evidence block already shows the matched passage, so a reason that repeats it is left out.
    fun repeats(line: String) = evidence.isNotEmpty() && PeopleText.plainText(line).contains(evidence)
    val broadLine = if (broad) broadReason(person) else ""
    val opener = person.opener?.takeIf { !broad && it.isNotEmpty() && !repeats(it) }
    val reasons = person.reasons.filter { it.isNotEmpty() && it != person.opener && !repeats(it) && !(broad && it == broadLine) }

    PersonFrame(modifier.testTag("person-${person.ref}"), broad = broad, revealed = revealed) {
        PersonHeader(person, state, host)
        if (broadLine.isNotEmpty()) PersonBroadLine(broadLine)
        if (person.around) {
            val myPresenceOn = state.presence.on
            AroundLine(PeopleCommonStrings.around(PeoplePrivacy.zone(person, myPresenceOn)), band = PeoplePrivacy.proximity(person, myPresenceOn))
        }
        person.about?.takeIf { it.isNotEmpty() }?.let {
            Text(it, style = Caddie.type.stateBody, color = c.text2)
        }
        if (!broad && !person.evidence.isNullOrEmpty()) PersonEvidence(person.evidence!!)
        if (opener != null) OpenerBox(opener)
        if (reasons.isNotEmpty()) PersonReasons(reasons, broad)
        PersonTopics(PeopleStrings.CAN_SPEAK_TO, person.speakTopics, broad)
        PersonTopics(PeopleStrings.WANTS_TO_LEARN, person.learnTopics, broad)
        PersonContact(person, host)
        PersonAction(person, state, host)
    }
}

/** BroadLine.tsx broadReason(): the "Also interested in …" reason a broad match leads with, else its opener. */
internal fun broadReason(person: Person): String =
    person.reasons.firstOrNull { it.startsWith(PeopleStrings.ALSO_INTERESTED_IN) } ?: person.opener.orEmpty()

/** True for a link the server itself accepts as `linkedin_url`, the only links a card opens. */
internal fun isLinkedInUrl(url: String): Boolean = LINKEDIN_URL.matches(url)

/**
 * The only LinkedIn links a card opens: the server's own rule for `linkedin_url` (docs/CONTRACT.md,
 * `PUT /api/people/profile`), so no backslash, user name, port or look-alike host can get through.
 */
private val LINKEDIN_URL = Regex("^https://(www\\.)?linkedin\\.com/in/[A-Za-z0-9_-]{3,100}/?$")

/** .pp-person-head: the name, the Sample pill and the overflow menu, whose button reaches 10 dp into the card's padding. */
@Composable
private fun PersonHeader(person: Person, state: PeopleUiState, host: PeopleHost) {
    val c = Caddie.colors
    val name = person.displayName
    Row(
        Modifier
            .fillMaxWidth()
            .layout { measurable, constraints ->
                // margin-right: -10px on the menu: the row is 10 dp wider than the card's content.
                val extra = 10.dp.roundToPx()
                val wider = if (constraints.hasBoundedWidth) constraints.copy(minWidth = constraints.maxWidth + extra, maxWidth = constraints.maxWidth + extra) else constraints
                val placeable = measurable.measure(wider)
                layout((placeable.width - extra).coerceAtLeast(0), placeable.height) { placeable.place(0, 0) }
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        PersonNameAndPill(
            name = {
                Text(
                    name,
                    style = if (person.broad) Caddie.type.cardTitle.copy(fontWeight = FontWeight.Medium) else Caddie.type.cardTitle,
                    color = if (person.broad) c.text2 else c.text,
                    modifier = Modifier.semantics { heading() },
                )
            },
            pill = if (person.sample) ({ SamplePill() }) else null,
            modifier = Modifier.weight(1f),
        )
        val items = buildList {
            if (state.features.reports) {
                add(MenuItem(PeopleCommonStrings.REPORT, { host.report(ReportTarget(person.ref, name, ReportKind.Profile, person.ref)) }))
            }
            add(MenuItem(PeopleCommonStrings.BLOCK, { host.confirmBlock(person.ref, name) }, destructive = true))
        }
        OverflowMenu(PeopleCommonStrings.optionsFor(name), items)
    }
}

/**
 * The name and the Sample pill of the header, 8 dp apart: the name takes the room the pill leaves,
 * as the web's flex: 1 does. When even the name's longest word does not fit beside the pill (at a
 * large font size), the pill goes under the name instead, so no word is broken.
 */
@Composable
private fun PersonNameAndPill(name: @Composable () -> Unit, pill: (@Composable () -> Unit)?, modifier: Modifier = Modifier) {
    Layout(
        contents = listOf(name, pill ?: {}),
        modifier = modifier,
    ) { (nameMeasurables, pillMeasurables), constraints ->
        val gap = 8.dp.roundToPx()
        val nameMeasurable = nameMeasurables.single()
        val width = constraints.maxWidth
        val pillPlaceable = pillMeasurables.firstOrNull()?.measure(Constraints(maxWidth = width))
        val room = if (pillPlaceable == null) width else (width - pillPlaceable.width - gap).coerceAtLeast(0)
        val stacked = pillPlaceable != null && nameMeasurable.minIntrinsicWidth(Constraints.Infinity) > room
        if (!stacked) {
            val namePlaceable = nameMeasurable.measure(Constraints(minWidth = room, maxWidth = room))
            val height = maxOf(namePlaceable.height, pillPlaceable?.height ?: 0)
            layout(width, height) {
                namePlaceable.place(0, (height - namePlaceable.height) / 2)
                pillPlaceable?.place(room + gap, (height - pillPlaceable.height) / 2)
            }
        } else {
            val namePlaceable = nameMeasurable.measure(Constraints(minWidth = width, maxWidth = width))
            val pillTop = namePlaceable.height + 4.dp.roundToPx()
            layout(width, pillTop + pillPlaceable.height) {
                namePlaceable.place(0, 0)
                pillPlaceable.place(0, pillTop)
            }
        }
    }
}

/** .pp-broad: the people icon (16, 3 dp down) and the reason, 15 sp secondary, with its highlights. */
@Composable
private fun PersonBroadLine(line: String) {
    val c = Caddie.colors
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        LucideImage(LucideIcon.Users, null, Modifier.padding(top = 3.dp), size = 16.dp, tint = c.text2)
        EvidenceText(line, Modifier.weight(1f), color = c.text2)
    }
}

/** .pp-evidence: the matched passage on the fill colour, a 3 dp accent bar on the left, radius 0/10/10/0, 15/1.45. */
@Composable
private fun PersonEvidence(evidence: String) {
    val c = Caddie.colors
    Box(
        Modifier
            .fillMaxWidth()
            .background(c.fill, RoundedCornerShape(topStart = 0.dp, topEnd = 10.dp, bottomEnd = 10.dp, bottomStart = 0.dp))
            .drawBehind { drawRect(c.accent, size = Size(3.dp.toPx(), size.height)) }
            .padding(start = 15.dp, end = 12.dp, top = 8.dp, bottom = 8.dp),
    ) {
        EvidenceText(evidence)
    }
}

/** .pp-reasons: a bulleted list, 14 sp, 4 dp apart, the bullets in a 20 dp gutter. */
@Composable
private fun PersonReasons(reasons: List<String>, broad: Boolean) {
    val c = Caddie.colors
    val color = if (broad) c.text2 else c.text
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        reasons.forEach { reason ->
            Row {
                Text("•", style = Caddie.type.meta, color = color, modifier = Modifier.width(20.dp).padding(start = 6.dp))
                EvidenceText(reason, Modifier.weight(1f), style = Caddie.type.meta, color = color)
            }
        }
    }
}

/** .pp-person-topics: the label (600, the text colour) and the first six labels, then "and {n} more", 14 sp secondary. */
@Composable
private fun PersonTopics(label: String, topics: List<TopicRef>, broad: Boolean) {
    if (topics.isEmpty()) return
    val c = Caddie.colors
    val shown = topics.take(6)
    val text = buildAnnotatedString {
        withStyle(SpanStyle(color = if (broad) c.text2 else c.text, fontWeight = FontWeight.SemiBold)) { append(label) }
        append(" ")
        append(shown.joinToString(", ") { it.label })
        if (topics.size > shown.size) append(PeopleStrings.andMore(topics.size - shown.size))
    }
    Text(text, style = Caddie.type.meta, color = c.text2)
}

/**
 * .pp-contact: under a hairline, "How to reach me", the LinkedIn link (.link: the external-link icon
 * and the label, 14/600 accent ink, 44 dp tall) and the contact note (15 sp). Shown when the server
 * sent either; the link only for an https linkedin.com address.
 */
@Composable
private fun PersonContact(person: Person, host: PeopleHost) {
    val contact = person.contact ?: return
    val url = contact.linkedinUrl?.takeIf { it.isNotEmpty() }
    val note = contact.contactNote?.takeIf { it.isNotEmpty() }
    if (url == null && note == null) return
    val c = Caddie.colors
    Column(Modifier.fillMaxWidth()) {
        Hairline()
        Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Subhead(PeopleStrings.HOW_TO_REACH_ME)
            if (url != null && isLinkedInUrl(url)) {
                Row(
                    Modifier
                        .heightIn(min = Caddie.dimens.minTouch)
                        .minimumInteractiveComponentSize()
                        .caddieClickable(RoundedCornerShape(4.dp)) { host.openUrl(url) }
                        .testTag("person-linkedin"),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    LucideImage(LucideIcon.ExternalLink, null, size = 16.dp, tint = c.accentInk)
                    Text(PeopleStrings.LINKEDIN_PROFILE, style = Caddie.type.buttonSmall, color = c.accentInk)
                }
            }
            if (note != null) Text(note, style = Caddie.type.stateBody, color = c.text)
        }
    }
}

/** .pp-person-actions: the card's one action, 2 dp further down than the card's other blocks. */
@Composable
private fun PersonAction(person: Person, state: PeopleUiState, host: PeopleHost) {
    val features = state.features
    val ref = person.ref
    val name = person.displayName
    val asked = if (features.meets) state.inbox.askStates[ref] else null
    val open = if (features.meets && asked != MeetState.Requested) {
        state.inbox.outgoing.firstOrNull { it.to?.ref == ref && it.state.isOpen }
            ?: state.inbox.incoming.firstOrNull { it.from?.ref == ref && it.state == MeetState.Active }
    } else {
        null
    }
    val around = person.around
    val sameZone = around && PeoplePrivacy.inMyZone(person, state.presence)
    val watched = state.watch.any { it.ref == ref }
    var waving by remember(ref) { mutableStateOf(false) }
    var toggling by remember(ref) { mutableStateOf(false) }

    ActionsRow(Modifier.padding(top = 2.dp)) {
        when {
            asked == MeetState.Requested -> Text(
                if (host.hasWaved(ref)) PeopleStrings.WAVED else PeopleCommonStrings.NO_REPLY_YET,
                style = Caddie.type.meta.copy(fontWeight = FontWeight.SemiBold),
                color = Caddie.colors.text2,
                modifier = Modifier
                    .heightIn(min = 36.dp)
                    .wrapContentHeight()
                    .semantics { liveRegion = LiveRegionMode.Polite }
                    .testTag("person-status"),
            )
            open != null -> CaddieButton(
                PeopleCommonStrings.OPEN_MEET_UP,
                { host.openMeet(open.meetId) },
                variant = ButtonVariant.Tonal,
                small = true,
            )
            features.meets && sameZone -> CaddieButton(
                if (waving) PeopleStrings.WAVING else PeopleStrings.WAVE,
                {
                    if (!waving) {
                        waving = true
                        // The app's scope, so the wave is sent even if the card leaves the list meanwhile.
                        host.scope.launch {
                            try {
                                sendWave(person, host)
                            } finally {
                                waving = false
                            }
                        }
                    }
                },
                variant = ButtonVariant.Primary,
                small = true,
                enabled = !waving,
                icon = LucideIcon.Hand,
            )
            features.meets && around -> CaddieButton(
                PeopleStrings.ASK_TO_TALK_SHOP,
                { host.ask(person) },
                variant = ButtonVariant.Tonal,
                small = true,
                icon = LucideIcon.MessageCircle,
            )
            features.presence -> CaddieButton(
                if (watched) PeopleStrings.WATCHING else PeopleStrings.WATCH,
                {
                    // Set before the launch, as waving: a second tap in the same frame would turn
                    // the watch straight back.
                    if (!toggling) {
                        toggling = true
                        host.scope.launch {
                            val on = try {
                                host.controller.toggleWatch(ref, name)
                            } finally {
                                toggling = false
                            }
                            host.showToast(if (on) PeopleStrings.watchOn(name) else PeopleStrings.stoppedWatching(name))
                        }
                    }
                },
                Modifier.semantics { toggleableState = ToggleableState(watched) },
                variant = if (watched) ButtonVariant.Tonal else ButtonVariant.Text,
                small = true,
                enabled = !toggling,
                icon = if (watched) LucideIcon.BellOff else LucideIcon.Bell,
            )
            else -> Unit
        }
    }
}
