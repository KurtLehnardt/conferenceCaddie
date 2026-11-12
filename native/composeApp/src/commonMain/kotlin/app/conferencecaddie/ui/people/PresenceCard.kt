package app.conferencecaddie.ui.people

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.bundle.IsoTime
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.shared.people.PositionOutcome
import app.conferencecaddie.shared.people.Presence
import app.conferencecaddie.shared.people.PresenceMode
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.CaddieIconButton
import app.conferencecaddie.ui.components.Hairline
import app.conferencecaddie.ui.components.Pill
import app.conferencecaddie.ui.components.caddieClickable
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.components.SectionHeading
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.PlatformTouchTarget
import kotlinx.coroutines.launch

/** The longest spot line ("Where in the zone"), as the web's SPOT_MAX. */
private const val SPOT_MAX = 60

/**
 * "I'm around" (web PresenceControls.tsx, spec section 5): a [PeopleCard] with 8 dp gaps on the
 * People home. The switch "Around and up for a conversation" ([PeopleSwitchRow],
 * [SwitchRowVariant.Presence]); while on, the zone line ([AroundLine] "{zone} · {spot}" from
 * `state.presence`), "Using your position too", Extend (`controller.extendPresence()`) or "On until
 * you turn it off today", "Change zone", and the position step ([PeopleNotice],
 * `PeopleText.POSITION_EXPLAINER`, `controller.sharePosition(on)`, shown only when
 * `state.features.gpsBands` and `state.locationAccess` allow); the setup panel (first-time
 * `PeopleText.PRESENCE_NOTICE`, the zone [PeopleSelect] over `state.zones` preselecting
 * `state.presence.zone ?: state.lastZone`, "How long" as [RadioRow]s with
 * `PeopleText.DURATION_LABELS`, the spot field (60), I'm around / Save =
 * `controller.turnOnPresence(zone, spot, mode)` with `PeopleText.presenceProblem` for failures);
 * U3's [PushControls] in the [PushVariant.Card] variant under a hairline; and [BleControls] in the
 * [BleVariant.Card] variant under another. Off is `controller.turnOffPresence()`. Shown only when
 * `state.features.presence`.
 *
 * The position is precise or nothing: when the phone allows only approximate location, or refuses
 * location, the card says so and offers the system settings ([PeopleHost.openAppSettings]); no position is
 * sent then.
 *
 * [hereZone] is the decoded zone of a `#/here/<zone>` link (`controller.matchZone(zone)`; it opens the
 * setup panel with that zone chosen and presence stays off until the person taps "I'm around"; an unknown
 * one says "That zone isn't on this conference's list. Pick one below."); call [onHereZoneHandled]
 * once it is taken. Owner U3.
 */
@Composable
fun PresenceControls(
    state: PeopleUiState,
    host: PeopleHost,
    modifier: Modifier = Modifier,
    hereZone: String? = null,
    onHereZoneHandled: () -> Unit = {},
) {
    if (!state.features.presence) return
    val controller = host.controller
    // The card's actions run on the app's scope (PeopleHost.scope), not one of the card's own: the
    // card is an item of the People home's list, so scrolling it away or leaving the tab while an
    // action is under way would cancel the action's caller and lose its toast or error. An outcome
    // the card shows itself goes in a toast once the card has left ([shown]). busy is set before
    // the launch, so a second tap in the same frame starts nothing.
    val shown = rememberInComposition()
    val presence = state.presence
    val zones = state.zones
    val currentState by rememberUpdatedState(state)
    val handled by rememberUpdatedState(onHereZoneHandled)

    // In the host's memory, which an answer after a re-creation still reaches (PeopleHost.presencePanel).
    var panel by host::presencePanel
    var zone by rememberSaveable { mutableStateOf("") }
    var modeName by rememberSaveable { mutableStateOf(presence.mode.name) }
    var spot by rememberSaveable { mutableStateOf(presence.spot) }
    var busy by remember { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var unknownZone by rememberSaveable { mutableStateOf(false) }
    var positionProblem by remember { mutableStateOf<PositionOutcome?>(null) }
    val mode = PresenceMode.valueOf(modeName)

    val visible = state.visibility.openToMeet && state.profile.displayName.isNotBlank()

    fun openPanel(preset: String?) {
        val s = currentState
        zone = preset ?: s.presence.zone ?: s.lastZone ?: s.zones.firstOrNull() ?: ""
        spot = s.presence.spot
        modeName = s.presence.mode.name
        error = null
        panel = true
    }

    // #/here/<zone>: the link only opens the setup panel with the zone chosen (when the
    // conference has that zone) so the person confirms with "I'm around". It never turns presence on
    // by itself, whatever the link says, because any app can open the link.
    var lastHere by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(hereZone) {
        val linked = hereZone ?: return@LaunchedEffect
        // The same link again while the card is up is taken without opening the panel twice.
        if (lastHere == linked) {
            handled()
            return@LaunchedEffect
        }
        lastHere = linked
        val match = controller.matchZone(linked)
        unknownZone = match == null
        openPanel(match)
        handled()
    }

    fun applyPanel() {
        if (busy) return
        val z = zone.ifEmpty { zones.firstOrNull() ?: return }
        val s = spot
        val m = mode
        busy = true
        error = null
        host.scope.launch {
            val err = try {
                controller.turnOnPresence(z, s, m)
            } finally {
                busy = false
            }
            if (err != null) {
                if (shown.value) error = err else host.showMessage(err)
            } else {
                panel = false
                unknownZone = false
            }
        }
    }

    // The switch shows on while the zone is being picked; "Not now" or a second tap puts it back.
    fun onSwitch(on: Boolean) {
        if (on) {
            openPanel(null)
        } else {
            panel = false
            if (currentState.presence.on) host.scope.launch { controller.turnOffPresence() }
        }
    }

    fun extend() {
        if (busy) return
        busy = true
        host.scope.launch {
            val err = try {
                controller.extendPresence()
            } finally {
                busy = false
            }
            // The web keeps the error for the closed panel, where it is never seen; here it is a toast.
            if (err != null) host.showMessage(err) else host.showToast(ConnectStrings.EXTENDED)
        }
    }

    // The optional step after the zone is chosen, shown once; the choice is kept on the device.
    val canLocate = state.features.gpsBands && state.locationAccess != LocationAccess.Unavailable
    val askPosition = presence.on && !panel && canLocate && presence.positionChoice == null

    fun choosePosition(on: Boolean) {
        if (busy) return
        busy = true
        positionProblem = null
        host.scope.launch {
            val outcome = try {
                controller.sharePosition(on)
            } finally {
                busy = false
            }
            when (outcome) {
                PositionOutcome.On -> if (on) host.showToast(ConnectStrings.USING_POSITION_TOAST)
                PositionOutcome.Denied, PositionOutcome.Approximate ->
                    if (shown.value) positionProblem = outcome else host.showPermissionProblem(positionProblemText(outcome))
                PositionOutcome.Off, PositionOutcome.Unavailable -> Unit
            }
        }
    }

    // Allowed in the system settings meanwhile: the explanation has done its work.
    LaunchedEffect(state.locationAccess) {
        if (state.locationAccess == LocationAccess.Precise) positionProblem = null
    }

    PeopleCard(modifier.testTag("presence-card"), gap = 8.dp) {
        PeopleSwitchRow(
            ConnectStrings.PRESENCE_LABEL,
            presence.on || panel,
            ::onSwitch,
            Modifier.testTag("presence-switch"),
            variant = SwitchRowVariant.Presence,
            enabled = !busy,
        )
        val onZone = presence.zone
        if (presence.on && onZone != null) {
            PresenceOn(
                host = host,
                presence = presence,
                zone = onZone,
                busy = busy,
                canLocate = canLocate,
                askPosition = askPosition,
                positionProblem = positionProblem,
                onExtend = ::extend,
                onChangeZone = { openPanel(null) },
                onPosition = ::choosePosition,
            )
        }
        if (panel) {
            PresenceSetup(
                state = state,
                host = host,
                zone = zone.ifEmpty { zones.firstOrNull() ?: "" },
                onZone = { zone = it },
                mode = mode,
                onMode = { modeName = it.name },
                spot = spot,
                onSpot = {
                    spot = it
                    error = null
                },
                error = error,
                unknownZone = unknownZone,
                visible = visible,
                busy = busy,
                onApply = ::applyPanel,
                onCancel = { panel = false },
            )
        }
        // Under the zone, duration and position: the push nudge switch, then Bluetooth, which shows
        // only where the backend resolves derived-v1 tokens and this phone has a radio for them.
        PushControls(state, host, PushVariant.Card)
        BleControls(state, host, BleVariant.Card)
    }
}

/** .pp-presence-on: the zone line, the time left, Change zone, the position toggle and step. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PresenceOn(
    host: PeopleHost,
    presence: Presence,
    zone: String,
    busy: Boolean,
    canLocate: Boolean,
    askPosition: Boolean,
    positionProblem: PositionOutcome?,
    onExtend: () -> Unit,
    onChangeZone: () -> Unit,
    onPosition: (Boolean) -> Unit,
) {
    val c = Caddie.colors
    Column(Modifier.fillMaxWidth().testTag("presence-on")) {
        Hairline()
        Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            AroundLine(if (presence.spot.isNotEmpty()) "$zone · ${presence.spot}" else zone)
            if (presence.position) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    LucideImage(LucideIcon.LocateFixed, null, size = 16.dp, tint = c.text2)
                    HintText(ConnectStrings.USING_POSITION)
                }
            }
            ActionsRow {
                if (presence.mode == PresenceMode.Day) {
                    ConnectAskedText(ConnectStrings.ON_UNTIL_OFF_TODAY)
                } else {
                    val untilMs = presence.until?.let { IsoTime.epochMillis(it) }
                    val now = rememberNowMs(host, active = true, key = presence.until)
                    CaddieButton(
                        ConnectStrings.turnsOffIn(PeopleText.minutesLeft(untilMs, now)),
                        onExtend,
                        Modifier.testTag("presence-extend"),
                        variant = ButtonVariant.Tonal,
                        small = true,
                        enabled = !busy,
                    )
                }
                CaddieButton(ConnectStrings.CHANGE_ZONE, onChangeZone, variant = ButtonVariant.Text, small = true, enabled = !busy)
                if (canLocate && presence.positionChoice != null) {
                    CaddieButton(
                        if (presence.position) ConnectStrings.STOP_USING_POSITION else ConnectStrings.USE_MY_POSITION_TOO,
                        { onPosition(!presence.position) },
                        variant = ButtonVariant.Text,
                        small = true,
                        enabled = !busy,
                    )
                }
            }
            if (positionProblem != null) PositionProblem(positionProblem, host)
            if (askPosition) {
                PeopleNotice(Modifier.testTag("position-step")) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        // .pp-subhead without its top margin.
                        SectionHeading(PeopleText.POSITION_LABEL)
                        Text(PeopleText.POSITION_EXPLAINER)
                        ActionsRow {
                            CaddieButton(ConnectStrings.USE_MY_POSITION, { onPosition(true) }, small = true, enabled = !busy)
                            CaddieButton(ConnectStrings.ZONE_ONLY, { onPosition(false) }, variant = ButtonVariant.Text, small = true, enabled = !busy)
                        }
                    }
                }
            }
        }
    }
}

/**
 * Native: why no position is sent (location refused, or approximate only) and the way to the
 * system settings, where precise location can be allowed.
 */
@Composable
private fun PositionProblem(outcome: PositionOutcome, host: PeopleHost) {
    Column(
        Modifier.fillMaxWidth().testTag("position-problem").semantics { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        HintText(positionProblemText(outcome))
        if (host.canOpenAppSettings) CaddieButton(ConnectStrings.OPEN_SETTINGS, host::openAppSettings, variant = ButtonVariant.Text, small = true)
    }
}

/** Why no position is sent, for [outcome] Approximate or Denied. */
private fun positionProblemText(outcome: PositionOutcome): String =
    if (outcome == PositionOutcome.Approximate) ConnectStrings.POSITION_APPROXIMATE else ConnectStrings.POSITION_DENIED

/** .pp-presence-setup: the first-time notice, the zone, how long, the spot line and I'm around / Save. */
@Composable
private fun PresenceSetup(
    state: PeopleUiState,
    host: PeopleHost,
    zone: String,
    onZone: (String) -> Unit,
    mode: PresenceMode,
    onMode: (PresenceMode) -> Unit,
    spot: String,
    onSpot: (String) -> Unit,
    error: String?,
    unknownZone: Boolean,
    visible: Boolean,
    busy: Boolean,
    onApply: () -> Unit,
    onCancel: () -> Unit,
) {
    val presence = state.presence
    Column(Modifier.fillMaxWidth().testTag("presence-setup")) {
        Hairline()
        Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (!presence.noticeSeen) {
                PeopleNotice { Text(PeopleText.PRESENCE_NOTICE) }
            }
            if (unknownZone) HintText(ConnectStrings.UNKNOWN_ZONE)
            if (!visible) {
                MessageWithLink(ConnectStrings.NEEDS_VISIBLE_PROFILE, PeopleCommonStrings.OPEN_MY_PROFILE, host::openProfile, error = false)
            }
            PeopleSelect(zone, state.zones, onZone, ConnectStrings.ZONE, Modifier.testTag("presence-zone"))
            // .pp-duration: the legend and the two radios, 6 dp apart.
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(ConnectStrings.HOW_LONG, style = Caddie.type.peopleLabel, color = Caddie.colors.text, modifier = Modifier.semantics { heading() })
                Column(Modifier.selectableGroup()) {
                    PresenceMode.entries.forEach { m ->
                        RadioRow(PeopleText.DURATION_LABELS.getValue(m), selected = mode == m, onClick = { onMode(m) })
                    }
                }
                if (mode == PresenceMode.Day) HintText(ConnectStrings.DAY_HINT)
            }
            val profileError = error?.let(host::opensProfile) == true
            PeopleTextField(
                spot,
                onSpot,
                ConnectStrings.SPOT_LABEL,
                placeholder = ConnectStrings.SPOT_PLACEHOLDER,
                hint = ConnectStrings.SPOT_HINT,
                error = error,
                // "Open my profile" after an error about the profile, as the web's spot hint has it.
                errorLinkLabel = if (profileError) PeopleCommonStrings.OPEN_MY_PROFILE else null,
                onErrorLink = host::openProfile,
                maxLength = SPOT_MAX,
                fieldModifier = Modifier.testTag("presence-spot"),
            )
            ActionsRow {
                CaddieButton(
                    when {
                        busy -> ConnectStrings.SAVING
                        presence.on -> ConnectStrings.SAVE
                        else -> ConnectStrings.I_AM_AROUND
                    },
                    onApply,
                    Modifier.testTag("presence-apply"),
                    small = true,
                    enabled = !busy,
                )
                CaddieButton(
                    if (presence.on) ConnectStrings.CANCEL else ConnectStrings.NOT_NOW,
                    onCancel,
                    variant = ButtonVariant.Text,
                    small = true,
                    enabled = !busy,
                )
            }
        }
    }
}

/**
 * "Still in {zone}?" (web PresenceControls.tsx StillHereRow, spec section 6), at the top of the
 * People home while `state.presence.on && state.presence.confirmPending`: an accent-tinted row with
 * the title (16/700), Close (`controller.dismissZoneCheck()`), and wrapping chips "Yes", up to four of
 * `state.likelyZones` and "Other…" (a [PeopleSelect] and "I'm here" / "Back"); a chip is
 * `controller.confirmZone(zone)`, and a new zone toasts "Now in {zone}". Owner U3.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun StillHereRow(state: PeopleUiState, host: PeopleHost, modifier: Modifier = Modifier) {
    val zone = state.presence.zone
    if (!state.presence.on || !state.presence.confirmPending || zone == null) return
    val c = Caddie.colors
    var busy by remember { mutableStateOf(false) }
    var picking by rememberSaveable { mutableStateOf(false) }
    var other by rememberSaveable { mutableStateOf("") }
    val zones = state.zones
    val likely = state.likelyZones

    // On the app's scope, not this row's: the answer ends the question, and the controller publishes
    // that before confirmZone returns, so the row can leave the composition (cancelling a scope of its
    // own) before the answer comes back, and "Now in {zone}" would never show.
    fun answer(z: String) {
        if (busy || z.isEmpty()) return
        busy = true
        host.scope.launch {
            val err = try {
                host.controller.confirmZone(z)
            } finally {
                busy = false
            }
            if (err != null) {
                host.showMessage(err)
            } else {
                picking = false
                if (z != zone) host.showToast(ConnectStrings.nowIn(z))
            }
        }
    }

    Column(
        modifier
            .fillMaxWidth()
            .testTag("still-here")
            .background(c.accentTint, RoundedCornerShape(Caddie.dimens.radius))
            .padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                ConnectStrings.stillIn(zone),
                style = Caddie.type.body.copy(fontWeight = FontWeight.Bold),
                color = c.text,
                modifier = Modifier.weight(1f).semantics { heading() },
            )
            CaddieIconButton(
                LucideIcon.X,
                Strings.Common.CLOSE,
                { if (!busy) host.scope.launch { host.controller.dismissZoneCheck() } },
                iconSize = 20.dp,
            )
        }
        if (!picking) {
            // .pp-still-chips: a row that wraps, 8 dp apart; each chip keeps the platform touch target (48 dp on Android).
            FlowRow(Modifier.fillMaxWidth().testTag("still-chips"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StillChip(ConnectStrings.YES, active = true, enabled = !busy) { answer(zone) }
                likely.forEach { z -> StillChip(z, active = false, enabled = !busy) { answer(z) } }
                StillChip(ConnectStrings.OTHER_ZONE, active = false, enabled = !busy) {
                    other = zones.firstOrNull { it != zone && it !in likely } ?: zones.firstOrNull() ?: ""
                    picking = true
                }
            }
        } else {
            PeopleSelect(other.ifEmpty { zones.firstOrNull() ?: "" }, zones, { other = it }, ConnectStrings.ZONE, Modifier.testTag("still-zone"))
            ActionsRow {
                CaddieButton(ConnectStrings.I_AM_HERE, { answer(other.ifEmpty { zones.firstOrNull() ?: "" }) }, small = true, enabled = !busy)
                CaddieButton(ConnectStrings.BACK, { picking = false }, variant = ButtonVariant.Text, small = true, enabled = !busy)
            }
        }
    }
}

/**
 * A chip of "Still in {zone}?" (.chip with .chip-main, no check mark): at least 36 dp tall inside a
 * 48 dp touch target, padding 0/14, 14/500; the active "Yes" fills with the accent tint and drops
 * the border. Unlike the shell's CaddieChip it grows with its text, so a large font size wraps the
 * label instead of clipping it.
 */
@Composable
private fun StillChip(label: String, active: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val c = Caddie.colors
    // The tappable box is the 48 dp one; the chip drawn in it keeps its 36 dp look.
    Box(
        Modifier.defaultMinSize(minWidth = PlatformTouchTarget, minHeight = PlatformTouchTarget).caddieClickable(Pill, enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .heightIn(min = Caddie.dimens.chipHeight)
                .background(if (active) c.accentTint else c.surface, Pill)
                .then(if (active) Modifier else Modifier.border(1.dp, c.borderStrong, Pill))
                .padding(horizontal = 14.dp, vertical = 6.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(label, style = Caddie.type.chip, color = if (active) c.accentInk else c.text)
        }
    }
}

/** .pp-hint.pp-asked: a 14/600 secondary line at least 36 dp tall ("On until you turn it off today"). */
@Composable
internal fun ConnectAskedText(text: String, modifier: Modifier = Modifier, leading: (@Composable () -> Unit)? = null) {
    Row(
        modifier.heightIn(min = 36.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        leading?.invoke()
        Text(text, style = Caddie.type.peopleLabel, color = Caddie.colors.text2)
    }
}
