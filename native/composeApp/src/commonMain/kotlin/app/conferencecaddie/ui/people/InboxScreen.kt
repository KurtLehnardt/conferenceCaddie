package app.conferencecaddie.ui.people

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.conferencecaddie.shared.bundle.IsoTime
import app.conferencecaddie.shared.people.ApiResult
import app.conferencecaddie.shared.people.MeetState
import app.conferencecaddie.shared.people.MeetView
import app.conferencecaddie.shared.people.PeoplePrivacy
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.theme.Caddie
import kotlin.math.ceil
import kotlin.math.max
import kotlinx.coroutines.launch

/**
 * Requests (web InboxScreen.tsx, spec section 9), the Requests page, drawn by the People layer only
 * online. While it shows, call `controller.setInboxVisible(true)`, and `false` when it goes (through
 * `host.scope`, which outlives the screen); the inbox is `state.inbox`, which the controller reads
 * at once and then polls. A [SectionTitle] "Requests"; "Checking…" until `state.inbox.loaded`;
 * [PeoplePrompt] (Inbox) "No requests yet"; each incoming ask as a [PersonFrame] (title 16/600 by
 * `same_zone` / topic, about, the note, the menu "Options for {name}" with Block,
 * `host.confirmBlock(ref, name)`), Accept (`controller.acceptMeet(id)`, then `host.openMeet(id)`;
 * 404/410 toast "That ask has run out."), Not now (`controller.declineMeet(id)`, silent for the
 * asker) and "Expires in {n} min"; then "Your requests" rows with "No reply yet" or "Open meet-up".
 * Only open asks (requested or active) show. Owner U3.
 */
@Composable
fun InboxScreen(state: PeopleUiState, host: PeopleHost, modifier: Modifier = Modifier) {
    DisposableEffect(host) {
        host.scope.launch { host.controller.setInboxVisible(true) }
        onDispose { host.scope.launch { host.controller.setInboxVisible(false) } }
    }
    val inbox = state.inbox
    val incoming = inbox.incoming.filter { it.state.isOpen }
    val outgoing = inbox.outgoing.filter { it.state.isOpen }
    val now = rememberNowMs(host, active = incoming.isNotEmpty())

    PeopleScreenColumn(modifier.testTag("inbox-screen")) {
        // .pp-section: 10 dp between its parts.
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SectionHead(ConnectStrings.REQUESTS)
            if (!inbox.loaded) HintText(ConnectStrings.CHECKING, pad = true)
            if (inbox.loaded && incoming.isEmpty()) {
                PeoplePrompt(ConnectStrings.NO_REQUESTS, Modifier.testTag("inbox-empty"), icon = LucideIcon.Inbox, body = ConnectStrings.NO_REQUESTS_BODY)
            }
            if (incoming.isNotEmpty()) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    incoming.forEach { meet -> key(meet.meetId) { IncomingCard(meet, host, now) } }
                }
            }
        }
        if (outgoing.isNotEmpty()) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SectionHead(ConnectStrings.YOUR_REQUESTS)
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    outgoing.forEach { meet -> key(meet.meetId) { OutgoingRow(meet, host) } }
                }
            }
        }
    }
}

/** IncomingCard: an ask to me, with Accept, Not now and its time left, or Open meet-up once active. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun IncomingCard(meet: MeetView, host: PeopleHost, nowMs: Long) {
    val c = Caddie.colors
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val shown = rememberInComposition()
    val name = meet.from?.displayName ?: meet.other.displayName
    val ref = meet.from?.ref ?: meet.other.ref
    val waiting = meet.state == MeetState.Requested
    // Only the zone the server sends for a same-zone ask, read through the privacy rules: it is
    // cleared once the two no longer share a zone or either presence ends.
    val zone = if (meet.sameZone) PeoplePrivacy.zone(meet) else null
    val topic = meet.topicLabel?.takeIf { it.isNotBlank() }
    val title = when {
        zone != null -> ConnectStrings.incomingSameZone(name, zone)
        topic != null -> ConnectStrings.incomingTopic(name, topic)
        else -> ConnectStrings.incoming(name)
    }
    val expires = if (waiting) expiresIn(meet.expiresAt, nowMs) else null

    // On the app's scope (PeopleHost.scope), not the card's or the screen's: an ask that ran out is
    // dropped by the controller before the answer comes back, which takes the card away, and
    // Requests can be left while Accept or Not now is under way. The answer then goes in a toast
    // ([shown]); an accepted ask offers its meet-up there rather than opening it over whatever shows. busy is set before the launch, so a second tap
    // in the same frame (Accept twice, or Accept then Not now) starts nothing.
    fun act(accept: Boolean) {
        if (busy) return
        busy = true
        error = null
        host.scope.launch {
            val res = try {
                if (accept) host.controller.acceptMeet(meet.meetId) else host.controller.declineMeet(meet.meetId)
            } finally {
                busy = false
            }
            when (res) {
                is ApiResult.Ok -> if (accept) {
                    if (shown.value) {
                        host.openMeet(meet.meetId)
                    } else {
                        host.showToast(ConnectStrings.ACCEPTED_TOAST, PeopleToastAction(PeopleCommonStrings.OPEN_MEET_UP) { host.openMeet(meet.meetId) })
                    }
                }
                is ApiResult.Failed -> {
                    val status = res.error.status
                    // The controller has already dropped an ask that ran out.
                    if (status == 404 || status == 410) {
                        if (accept) host.showToast(ConnectStrings.RAN_OUT)
                    } else {
                        val message = res.error.message.ifBlank { PeopleCommonStrings.NOT_SAVED }
                        if (shown.value) error = message else host.showMessage(message)
                    }
                }
            }
        }
    }

    PersonFrame(Modifier.testTag("incoming-${meet.meetId}")) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // .pp-inbox-card .pp-person-name: the name's style at 16 sp.
            Text(
                title,
                style = Caddie.type.cardTitle.copy(fontSize = 16.sp),
                color = c.text,
                modifier = Modifier.weight(1f).semantics { heading() },
            )
            if (ref != null) {
                OverflowMenu(
                    PeopleCommonStrings.optionsFor(name),
                    listOf(MenuItem(PeopleCommonStrings.BLOCK, { host.confirmBlock(ref, name) }, destructive = true)),
                )
            }
        }
        meet.from?.about?.takeIf { it.isNotBlank() }?.let { Text(it, style = Caddie.type.stateBody, color = c.text2) }
        meet.note?.takeIf { it.isNotBlank() }?.let { ConnectNoteBox(it) }
        error?.let { ErrorText(it) }
        // .pp-actions.pp-person-actions: Accept, Not now and, pushed to the end, the time left.
        FlowRow(
            Modifier.fillMaxWidth().padding(top = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            if (waiting) {
                CaddieButton(ConnectStrings.ACCEPT, { act(true) }, Modifier.testTag("accept-${meet.meetId}"), small = true, enabled = !busy)
                CaddieButton(ConnectStrings.NOT_NOW, { act(false) }, Modifier.testTag("decline-${meet.meetId}"), variant = ButtonVariant.Text, small = true, enabled = !busy)
                if (expires != null) {
                    Text(
                        expires,
                        style = Caddie.type.meta,
                        color = c.text2,
                        textAlign = TextAlign.End,
                        modifier = Modifier.weight(1f).heightIn(min = 36.dp).wrapContentHeight(Alignment.CenterVertically),
                    )
                }
            } else {
                CaddieButton(PeopleCommonStrings.OPEN_MEET_UP, { host.openMeet(meet.meetId) }, variant = ButtonVariant.Tonal, small = true)
            }
        }
    }
}

/** .pp-outgoing-row: my open ask, with "No reply yet" or "Open meet-up". */
@Composable
private fun OutgoingRow(meet: MeetView, host: PeopleHost) {
    val c = Caddie.colors
    val shape = RoundedCornerShape(Caddie.dimens.radius)
    Row(
        Modifier
            .fillMaxWidth()
            .testTag("outgoing-${meet.meetId}")
            .heightIn(min = Caddie.dimens.minTouch)
            .background(c.surface, shape)
            .border(1.dp, c.border, shape)
            .padding(horizontal = 16.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            meet.to?.displayName ?: meet.other.displayName,
            style = Caddie.type.body.copy(fontWeight = FontWeight.SemiBold),
            color = c.text,
            modifier = Modifier.weight(1f),
        )
        if (meet.state == MeetState.Requested) {
            HintText(PeopleCommonStrings.NO_REPLY_YET)
        } else {
            CaddieButton(PeopleCommonStrings.OPEN_MEET_UP, { host.openMeet(meet.meetId) }, variant = ButtonVariant.Tonal, small = true)
        }
    }
}

/**
 * An ask's note in the .pp-opener box (accent tint, radius 10, the speech bubble). Unlike
 * [OpenerBox] the note is the asker's own words, shown as they are, as the web shows them: nothing
 * in it is read as markup.
 */
@Composable
private fun ConnectNoteBox(text: String, modifier: Modifier = Modifier) {
    val c = Caddie.colors
    Row(
        modifier.fillMaxWidth().background(c.accentTint, RoundedCornerShape(10.dp)).padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LucideImage(LucideIcon.MessageCircle, null, Modifier.padding(top = 2.dp), size = 18.dp, tint = c.accentInk)
        Text(text, style = Caddie.type.stateBody, color = c.text, modifier = Modifier.weight(1f))
    }
}

/** expiresIn(): "Expires in {n} min" for an ask, at least one minute, or null when the time is unknown. */
private fun expiresIn(expiresAt: String?, nowMs: Long): String? {
    val at = expiresAt?.let { IsoTime.epochMillis(it) } ?: return null
    return ConnectStrings.expiresIn(max(1, ceil((at - nowMs) / 60_000.0).toInt()))
}
