package app.conferencecaddie.ui.people

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import app.conferencecaddie.shared.bundle.IsoTime
import app.conferencecaddie.shared.people.ApiResult
import app.conferencecaddie.shared.people.MeetState
import app.conferencecaddie.shared.people.MeetView
import app.conferencecaddie.shared.people.PeopleError
import app.conferencecaddie.shared.people.PeoplePrivacy
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.shared.people.ReportKind
import app.conferencecaddie.shared.people.SeenPerson
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.ConfirmDialog
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.components.StateAction
import app.conferencecaddie.ui.components.Pill
import app.conferencecaddie.ui.components.caddieClickable
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.PlatformTouchTarget
import app.conferencecaddie.ui.theme.touchTargetIn
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** The longest how-to-spot-me line, as the web's SPOT_ME_MAX. */
private const val SPOT_ME_MAX = 60

/** What Meet up shows (MeetScreen.tsx View). */
private sealed interface MeetUi {
    data object Loading : MeetUi

    /** Over, not found, not mine, declined, cancelled by them, or another error: [message] and Back to People. */
    data class Ended(val message: String) : MeetUi

    /** An open meet, as last read, with the distance the privacy rules allow (only while active). */
    @Immutable
    data class Live(val meet: MeetView, val distance: PeoplePrivacy.Distance?) : MeetUi

    data class Found(val name: String, val about: String?) : MeetUi

    /** I cancelled it. */
    data object Cancelled : MeetUi
}

/**
 * Meet up (web MeetScreen.tsx, spec section 10), the Meet up page for [meetId], drawn by the People
 * layer only online. Reads the meet with `controller.readMeet(meetId)` every
 * `controller.meetPollIntervalMs()` while it shows and the app is in the foreground; zone, spot lines
 * and distance only through PeoplePrivacy. States: "Checking…"; the ended prompts ([PeoplePrompt]
 * without an icon, "Back to People" = `host.openPeople()`); found ("You found {name}",
 * `controller.personForMeet(meetId)`, "Save this person" = `controller.saveMet(name, about)`); live:
 * the lede, the meeting point card (`controller.setMeetingPoint`, [PeopleSelect] over
 * `state.zones`), their card (menu with Report, `host.report(ReportTarget(ref, name,
 * ReportKind.Meet, meetId))`; the spot line's Report with ReportKind.Spot), my "How to spot me" card
 * (`controller.setSpotMe`), the distance card, the caveat, "We found each other"
 * (`controller.foundMeet`) and Cancel (ButtonVariant.Text, accent ink; a ConfirmDialog, then
 * `controller.cancelMeet`).
 *
 * The distance card shows the distance only: the web's "Point me" compass needs the phone's heading,
 * which these apps do not read yet, so it is left out as the web leaves it out without a compass.
 * Owner U3.
 */
@Composable
fun MeetScreen(meetId: String, state: PeopleUiState, host: PeopleHost, modifier: Modifier = Modifier) {
    val controller = host.controller
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // The actions run on the app's scope (PeopleHost.scope), not one of this screen's own: Back, or
    // another tab, while an action is under way would cancel its caller and lose its answer. An
    // answer this screen shows itself goes in a toast once the screen has left ([shown]). They run
    // one at a time under the meet-up's name (PeopleHost.launchOnce), so a second tap in the same
    // frame, or on a Meet up opened again while one is under way, starts nothing.
    val shown = rememberInComposition()
    var view by remember { mutableStateOf<MeetUi>(MeetUi.Loading) }
    var spotMe by rememberSaveable { mutableStateOf("") }
    var spotSaved by remember { mutableStateOf(false) }
    var spotError by remember { mutableStateOf<String?>(null) }
    var rendezvous by remember { mutableStateOf("") }
    var picking by remember { mutableStateOf(false) }
    val busy = host.isRunning("meet:$meetId")
    var confirmCancel by remember { mutableStateOf(false) }
    // Not state: what the poll checks. The last open meet shown is kept for the found view when
    // the other person ends it.
    val run = remember { MeetRun() }

    // The found view is kept in the host's memory as well (PeopleHost.foundPerson): the server answers
    // a found meet-up with 410, so a Meet up composed again after a re-creation could not read it.
    fun foundView(d: MeetView): MeetUi {
        val about = d.other.about.takeIf { it.isNotEmpty() }
        host.markFound(meetId, d.other.displayName, about)
        return MeetUi.Found(d.other.displayName, about)
    }

    suspend fun load() {
        val res = controller.readMeet(meetId)
        if (run.stopped) return
        when (res) {
            is ApiResult.Ok -> {
                val d = res.value.meet
                run.lastLive = d
                val mine = d.mine.spotMe
                if (!run.seededSpot && !mine.isNullOrEmpty()) {
                    run.seededSpot = true
                    // Text restored after an activity's re-creation is what was typed; it stays.
                    if (spotMe.isEmpty()) spotMe = mine
                }
                d.rendezvous?.takeIf { it.isNotEmpty() }?.let { rendezvous = it }
                view = when (d.state) {
                    // The other side ended it, or it ran out.
                    MeetState.Found -> foundView(d)
                    MeetState.Cancelled, MeetState.Declined, MeetState.Expired ->
                        MeetUi.Ended(if (d.state == MeetState.Declined) ConnectStrings.SAID_NOT_NOW else ConnectStrings.MEET_OVER)
                    else -> MeetUi.Live(d, PeoplePrivacy.distance(res.value))
                }
            }
            is ApiResult.Failed -> {
                val e = res.error
                // A meet this screen was showing ended on the other phone: 410 says how. They tapped
                // "We found each other", so this side gets the found view too; or they cancelled it.
                val ended = if (e.status == 410) e.state else null
                val live = run.lastLive
                if (live != null && (ended == MeetState.Found || ended == MeetState.Cancelled)) {
                    run.stopped = true
                    view = if (ended == MeetState.Found) foundView(live) else MeetUi.Ended(ConnectStrings.cancelledBy(live.other.displayName))
                    return
                }
                // A passing failure keeps the meet on screen; a refusal ends it.
                val current = view
                view = if (current is MeetUi.Live && e.status !in 400..499) current else MeetUi.Ended(meetProblem(e).first)
            }
        }
    }

    // Read at once, then every 15 seconds (stretched by the API's pace), skipped while the app is
    // in the background, as the web skips a hidden page.
    LaunchedEffect(meetId) {
        // Nothing to read once it is found: the server would answer 410.
        if (host.foundPerson(meetId) != null) return@LaunchedEffect
        run.stopped = false
        load()
        while (isActive) {
            delay(controller.meetPollIntervalMs())
            if (!run.stopped && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) load()
        }
    }

    /** Runs [action] on the app's scope under the meet-up's name, unless one is under way already. */
    fun act(action: suspend () -> Unit) {
        host.launchOnce("meet:$meetId", action)
    }

    fun found() {
        val live = view as? MeetUi.Live ?: return
        act {
            when (val res = controller.foundMeet(meetId)) {
                is ApiResult.Ok -> {
                    run.stopped = true
                    view = foundView(live.meet)
                    // The found view, with "Save this person", is on this screen.
                    if (!shown.value) host.showToast(ConnectStrings.youFound(live.meet.other.displayName))
                }
                is ApiResult.Failed -> {
                    val (message, over) = meetProblem(res.error)
                    if (over) {
                        run.stopped = true
                        view = foundView(live.meet)
                        if (!shown.value) host.showToast(message)
                    } else {
                        host.showToast(message)
                    }
                }
            }
        }
    }

    fun cancel() {
        confirmCancel = false
        act {
            when (val res = controller.cancelMeet(meetId)) {
                is ApiResult.Ok -> {
                    run.stopped = true
                    view = MeetUi.Cancelled
                    if (!shown.value) host.showToast(ConnectStrings.MEET_CANCELLED)
                }
                is ApiResult.Failed -> {
                    val (message, over) = meetProblem(res.error)
                    if (over) {
                        run.stopped = true
                        view = MeetUi.Cancelled
                        if (!shown.value) host.showToast(message)
                    } else {
                        host.showToast(message)
                    }
                }
            }
        }
    }

    fun saveSpotMe() {
        spotError = null
        val text = spotMe.trim().take(SPOT_ME_MAX)
        act {
            when (val res = controller.setSpotMe(meetId, text)) {
                is ApiResult.Ok -> if (shown.value) spotSaved = true else host.showToast(ConnectStrings.SAVED)
                is ApiResult.Failed -> {
                    val message = res.error.message.ifBlank { PeopleCommonStrings.NOT_SAVED }
                    if (shown.value) spotError = message else host.showToast(message)
                }
            }
        }
    }

    fun setMeetingPoint(zone: String) {
        if (zone.isEmpty()) return
        act {
            when (val res = controller.setMeetingPoint(meetId, zone)) {
                is ApiResult.Ok -> {
                    rendezvous = zone
                    picking = false
                    (view as? MeetUi.Live)?.let { view = it.copy(meet = it.meet.copy(rendezvous = zone)) }
                    if (!shown.value) host.showToast(ConnectStrings.meetAt(zone))
                }
                is ApiResult.Failed -> host.showToast(res.error.message.ifBlank { PeopleCommonStrings.NOT_SAVED })
            }
        }
    }

    // A found view this Meet up, or the one before a re-creation, got to comes first.
    val kept = host.foundPerson(meetId)
    when (val v = if (kept != null) MeetUi.Found(kept.first, kept.second) else view) {
        MeetUi.Loading -> PeopleScreenColumn(modifier.testTag("meet-screen")) { HintText(ConnectStrings.CHECKING, pad = true) }
        is MeetUi.Ended -> PeopleScreenColumn(modifier.testTag("meet-screen")) { MeetEndedPrompt(v.message, host) }
        MeetUi.Cancelled -> PeopleScreenColumn(modifier.testTag("meet-screen")) { MeetEndedPrompt(ConnectStrings.MEET_CANCELLED, host) }
        is MeetUi.Found -> PeopleScreenColumn(modifier.testTag("meet-screen")) { FoundCard(meetId, v, host) }
        is MeetUi.Live -> PeopleScreenColumn(modifier.testTag("meet-screen")) {
            val d = v.meet
            val name = d.other.displayName
            val active = d.state == MeetState.Active
            val until = d.activeUntil?.let { IsoTime.epochMillis(it) }
            val now = rememberNowMs(host, active = active && until != null, key = d.activeUntil)
            val minutes = if (until != null) PeopleText.minutesLeft(until, now) else null
            // Reports name the other person by their ref, which the server sends with the meet.
            val otherRef = d.other.ref
            val report: (ReportKind) -> Unit = { kind ->
                if (otherRef != null) host.report(ReportTarget(otherRef, name, kind, if (kind == ReportKind.Meet) meetId else otherRef))
            }
            // Same zone: they are already next to each other, so how to spot each other comes first
            // and the meeting point is optional.
            val sameZone = d.sameZone
            val theirZone = PeoplePrivacy.zone(d)
            val myZone = if (state.presence.on) state.presence.zone else null
            val sharedZone = if (sameZone) theirZone ?: d.rendezvous ?: myZone else null

            if (d.state == MeetState.Requested) {
                val hint = Caddie.type.meta
                Text(
                    buildAnnotatedString {
                        append(ConnectStrings.waitingFor(name))
                        append(" ")
                        withStyle(SpanStyle(fontSize = hint.fontSize)) { append(ConnectStrings.NO_REPLY_YET_DOT) }
                    },
                    style = Caddie.type.stateBody,
                    color = Caddie.colors.text2,
                    modifier = Modifier.testTag("meet-waiting"),
                )
            }
            if (sameZone && sharedZone != null && active) {
                Text(
                    ConnectStrings.bothIn(sharedZone),
                    style = Caddie.type.stateBody.copy(fontWeight = FontWeight.SemiBold),
                    color = Caddie.colors.text2,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }

            val rendezvousCard: @Composable () -> Unit = {
                RendezvousCard(
                    current = d.rendezvous,
                    sameZone = sameZone,
                    picking = picking,
                    value = rendezvous.ifEmpty { theirZone ?: state.zones.firstOrNull() ?: "" },
                    zones = state.zones,
                    busy = busy,
                    onPick = { picking = true },
                    onChange = { rendezvous = it },
                    onSet = { setMeetingPoint(rendezvous.ifEmpty { theirZone ?: state.zones.firstOrNull() ?: "" }) },
                    onCancel = { picking = false },
                )
            }
            val themCard: @Composable () -> Unit = {
                ThemCard(d, theirZone, active, minutes, canReport = otherRef != null, onReport = report)
            }
            val meCard: @Composable () -> Unit = {
                PeopleCard(Modifier.testTag("meet-me"), title = ConnectStrings.HOW_TO_SPOT_ME, gap = 10.dp) {
                    if (sameZone && spotMe.isEmpty()) HintText(ConnectStrings.addALine(name))
                    PeopleTextField(
                        spotMe,
                        {
                            spotMe = it
                            spotSaved = false
                            spotError = null
                        },
                        ConnectStrings.SPOT_ME_LABEL,
                        placeholder = ConnectStrings.SPOT_ME_PLACEHOLDER,
                        hint = if (spotSaved) ConnectStrings.SAVED else ConnectStrings.spotMeCount(spotMe.length),
                        error = spotError,
                        maxLength = SPOT_ME_MAX,
                        fieldModifier = Modifier.testTag("meet-spot-me"),
                    )
                    CaddieButton(
                        ConnectStrings.SAVE,
                        ::saveSpotMe,
                        Modifier.testTag("meet-spot-me-save"),
                        variant = ButtonVariant.Tonal,
                        small = true,
                        enabled = !busy && !spotSaved,
                    )
                }
            }
            if (sameZone) {
                themCard()
                meCard()
                rendezvousCard()
            } else {
                rendezvousCard()
                themCard()
                meCard()
            }

            // Below the meeting point, their zone and the spot-me lines, never above: a rough aid,
            // not the plan. The privacy rules give a distance only while the meet is active.
            v.distance?.let { distance ->
                PeopleCard(Modifier.testTag("meet-distance"), title = ConnectStrings.distance(distance.meters), gap = 10.dp) {}
            }

            Text(
                ConnectStrings.CAVEAT,
                style = Caddie.type.stateBody.copy(fontWeight = FontWeight.SemiBold),
                color = Caddie.colors.text2,
            )
            ActionsRow {
                CaddieButton(ConnectStrings.FOUND_EACH_OTHER, ::found, Modifier.testTag("meet-found"), enabled = !busy)
                // .pp-danger renders in the accent ink: a text button.
                CaddieButton(ConnectStrings.CANCEL, { confirmCancel = true }, Modifier.testTag("meet-cancel"), variant = ButtonVariant.Text, enabled = !busy)
            }
        }
    }

    if (confirmCancel) {
        ConfirmDialog(
            title = ConnectStrings.CANCEL_MEET_TITLE,
            body = ConnectStrings.CANCEL_MEET_BODY,
            confirmLabel = ConnectStrings.CANCEL_MEET_CONFIRM,
            onConfirm = ::cancel,
            onDismiss = { confirmCancel = false },
            destructive = true,
            testTag = "meet-cancel-confirm",
        )
    }
}

/** What the poll of one Meet up checks, outside the composition's state. */
private class MeetRun {
    var stopped = false
    var seededSpot = false
    var lastLive: MeetView? = null
}

/** MeetScreen.tsx problem(): the line for a failed meet request, and whether the meet is over for good. */
private fun meetProblem(error: PeopleError): Pair<String, Boolean> = when (error.status) {
    410 -> ConnectStrings.MEET_OVER to true
    404 -> ConnectStrings.MEET_NOT_FOUND to true
    403 -> ConnectStrings.MEET_NOT_YOURS to true
    else -> error.message.ifBlank { ConnectStrings.MEET_UNAVAILABLE } to false
}

/** The ended states: a .pp-prompt without an icon, its title read out, and "Back to People". */
@Composable
private fun MeetEndedPrompt(title: String, host: PeopleHost) {
    PeoplePrompt(
        title,
        Modifier.testTag("meet-ended").semantics { liveRegion = LiveRegionMode.Polite },
        action = StateAction(ConnectStrings.BACK_TO_PEOPLE, { host.openPeople() }),
        actionVariant = ButtonVariant.Tonal,
    )
}

/** .pp-found: "You found {name}", the opener or the hint, and "Save this person" / "Back to People". */
@Composable
private fun FoundCard(meetId: String, found: MeetUi.Found, host: PeopleHost) {
    val seen by produceState<SeenPerson?>(null, meetId) { value = host.controller.personForMeet(meetId) }
    // In the host's memory, as the found view is: shown again after a re-creation, the view says the
    // person was saved instead of offering to save them twice.
    val saved = host.metSaved(meetId)
    val opener = seen?.opener?.takeIf { it.isNotBlank() } ?: seen?.reasons?.firstOrNull()?.takeIf { it.isNotBlank() }
    PeopleCard(Modifier.testTag("meet-found-card"), gap = 14.dp) {
        PeopleCardTitle(ConnectStrings.youFound(found.name), Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        if (opener != null) OpenerBox(opener) else HintText(ConnectStrings.FOUND_HINT)
        ActionsRow {
            if (saved) {
                ConnectAskedText(
                    ConnectStrings.SAVED_UNDER_SETTINGS,
                    Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    leading = { LucideImage(LucideIcon.Check, null, size = 16.dp, tint = Caddie.colors.text2) },
                )
            } else {
                CaddieButton(
                    ConnectStrings.SAVE_PERSON,
                    {
                        // Checked and marked before anything else: a second tap in the same frame,
                        // before the button gives way to "Saved under Settings", saves nobody twice.
                        if (!host.metSaved(meetId)) {
                            host.markMetSaved(meetId)
                            val about = found.about ?: seen?.about ?: ""
                            host.scope.launch { host.controller.saveMet(found.name, about) }
                            host.showToast(ConnectStrings.SAVED_TOAST)
                        }
                    },
                    small = true,
                )
            }
            CaddieButton(ConnectStrings.BACK_TO_PEOPLE, { host.openPeople() }, variant = ButtonVariant.Text, small = true)
        }
    }
}

/** The meeting point: "Meet at {zone}" / "Meeting point (optional)" / "No meeting point yet", and its picker. */
@Composable
private fun RendezvousCard(
    current: String?,
    sameZone: Boolean,
    picking: Boolean,
    value: String,
    zones: List<String>,
    busy: Boolean,
    onPick: () -> Unit,
    onChange: (String) -> Unit,
    onSet: () -> Unit,
    onCancel: () -> Unit,
) {
    val title = when {
        !current.isNullOrEmpty() -> ConnectStrings.meetAt(current)
        sameZone -> ConnectStrings.MEETING_POINT_OPTIONAL
        else -> ConnectStrings.NO_MEETING_POINT
    }
    PeopleCard(Modifier.testTag("meet-rendezvous"), title = title, gap = 10.dp) {
        if (!picking) {
            CaddieButton(
                if (!current.isNullOrEmpty()) ConnectStrings.CHANGE_MEETING_POINT else ConnectStrings.SET_MEETING_POINT,
                onPick,
                variant = ButtonVariant.Tonal,
                small = true,
                enabled = !busy,
            )
        } else {
            PeopleSelect(value, zones, onChange, ConnectStrings.MEETING_POINT, Modifier.testTag("meet-rendezvous-zone"))
            ActionsRow {
                CaddieButton(ConnectStrings.SET, onSet, Modifier.testTag("meet-rendezvous-set"), small = true, enabled = !busy)
                CaddieButton(ConnectStrings.CANCEL, onCancel, variant = ButtonVariant.Text, small = true)
            }
        }
    }
}

/**
 * Their card: the name and its menu (Report the meet-up), their zone and spot line with the spot
 * line's Report, how to spot them, and the minutes left. Zone, spot and spot-me come through
 * PeoplePrivacy only: the spot lines only while the meet is active.
 */
@Composable
private fun ThemCard(
    meet: MeetView,
    zone: String?,
    active: Boolean,
    minutes: Int?,
    canReport: Boolean,
    onReport: (ReportKind) -> Unit,
) {
    val c = Caddie.colors
    val name = meet.other.displayName
    val spot = PeoplePrivacy.spot(meet)
    val spotMe = PeoplePrivacy.spotMe(meet)
    PeopleCard(Modifier.testTag("meet-them"), gap = 10.dp) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PeopleCardTitle(name, Modifier.weight(1f))
            if (canReport) {
                OverflowMenu(PeopleCommonStrings.optionsFor(name), listOf(MenuItem(PeopleCommonStrings.REPORT, { onReport(ReportKind.Meet) })))
            }
        }
        if (zone != null) {
            Row(Modifier.fillMaxWidth().testTag("meet-them-zone"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                AroundLine(if (spot != null) "$zone · $spot" else zone, Modifier.weight(1f))
                if (spot != null && canReport) SpotReportButton { onReport(ReportKind.Spot) }
            }
        } else {
            HintText(if (active) ConnectStrings.NOT_SAID_WHERE else ConnectStrings.notAroundNow(name))
        }
        Subhead(ConnectStrings.HOW_TO_SPOT_THEM)
        if (spotMe != null) {
            Text(spotMe, style = Caddie.type.stateTitle, color = c.text, modifier = Modifier.testTag("meet-spot-them"))
        } else {
            HintText(ConnectStrings.NOT_SAID_SPOT)
        }
        if (active && minutes != null) HintText(ConnectStrings.minutesLeft(minutes))
    }
}

/**
 * .pp-spot-report: the small "Report" text button at the end of their zone line (padding 0/8,
 * 14/600 accent ink). The web's is 32 dp tall; this one keeps a touch target of at least 48 dp.
 */
@Composable
internal fun SpotReportButton(onClick: () -> Unit) {
    Box(
        Modifier
            .touchTargetIn(minWidth = PlatformTouchTarget, minHeight = PlatformTouchTarget)
            .caddieClickable(Pill, onClick = onClick)
            .padding(horizontal = 8.dp)
            .testTag("meet-spot-report"),
        contentAlignment = Alignment.Center,
    ) {
        Text(PeopleCommonStrings.REPORT, style = Caddie.type.buttonSmall, color = Caddie.colors.accentInk)
    }
}
