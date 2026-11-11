package app.conferencecaddie.ui.people

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.people.PeopleError
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.shared.people.PushOutcome
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.Hairline
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.components.SettingsTextRow
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.theme.Caddie
import kotlinx.coroutines.launch

/**
 * NudgeBanner (web NudgeBanner.tsx, spec section 7a), on the People home while `state.nudge` is set:
 * a [PeopleBanner] with `nudge = true` (Sparkles, the accent-ink border), `state.nudge.text`, Dismiss
 * (`controller.dismissNudge()`) and "See who" (`controller.seeWho()`, then [onSeeWho], so U2's
 * screen shows the Around view where `state.reveal` rings the card). The text is the controller's
 * sentence as it stands: the evidence and the zone, never a distance, and a name only for someone
 * on the watch list. Owner U3.
 */
@Composable
fun NudgeBanner(state: PeopleUiState, host: PeopleHost, onSeeWho: () -> Unit, modifier: Modifier = Modifier) {
    val nudge = state.nudge ?: return
    val seeWho by rememberUpdatedState(onSeeWho)
    // The banner leaves as soon as the controller drops the nudge, so the work runs in the host's
    // scope, which outlives it.
    PeopleBanner(
        LucideIcon.Sparkles,
        modifier.testTag("nudge-banner"),
        nudge = true,
        onClose = { host.scope.launch { host.controller.dismissNudge() } },
        closeLabel = ConnectStrings.DISMISS,
        actions = {
            CaddieButton(
                ConnectStrings.SEE_WHO,
                {
                    host.scope.launch {
                        host.controller.seeWho()
                        seeWho()
                    }
                },
                variant = ButtonVariant.Tonal,
                small = true,
            )
        },
    ) { Text(nudge.text) }
}

/**
 * The rows of the Nudges group in Settings (web NudgeBanner.tsx NudgeSetting), drawn inside U1's
 * group card: the [PeopleSwitchRow] ([SwitchRowVariant.Settings], first) with
 * `PeopleText.NUDGE_SETTING_LABEL`, `state.nudgesOn` and `controller.setNudgesEnabled(on)`, then the
 * web's explanation as a settings text row. Owner U3.
 */
@Composable
fun NudgeSetting(state: PeopleUiState, host: PeopleHost) {
    val scope = rememberCoroutineScope()
    PeopleSwitchRow(
        PeopleText.NUDGE_SETTING_LABEL,
        state.nudgesOn,
        { on -> scope.launch { host.controller.setNudgesEnabled(on) } },
        Modifier.testTag("nudge-setting"),
        variant = SwitchRowVariant.Settings,
    )
    SettingsTextRow(ConnectStrings.NUDGE_SETTING_TEXT)
}

/** Where [PushControls] sits. */
enum class PushVariant {
    /** In the presence card, under a hairline, with the BellRing icon. */
    Card,

    /** In Settings' Push group card, with its explanation row. */
    Settings,
}

/** What PushControls shows under its switch. */
private sealed interface PushPanel {
    /** PUSH_NOTICE, before the first permission request. */
    data object Notice : PushPanel

    /** Notifications are refused: the hint and the way to the system settings. */
    data object Denied : PushPanel

    /** Why push did not turn on. */
    data class Hint(val text: String) : PushPanel
}

/**
 * Push nudges (web PushControls.tsx, spec section 7b), only when `state.push.available`: the switch
 * `PeopleText.PUSH_LABEL` with "On" while `state.push.on`; turning it on shows `PeopleText.PUSH_NOTICE`
 * first (`controller.markPushNoticeSeen()`), then `controller.enablePush()`, whose PushOutcome picks
 * the toast ("Nudges on") or the hint; off is `controller.disablePush()`. [variant] places it in the
 * presence card or in Settings. Without native push (`state.push.available` false) it draws nothing,
 * as the web's switch does where push is unsupported. The web's Add to Home Screen steps have no
 * native counterpart; a refused permission offers the system settings instead. Owner U3.
 */
@Composable
fun PushControls(state: PeopleUiState, host: PeopleHost, variant: PushVariant, modifier: Modifier = Modifier) {
    if (!state.push.available) return
    val controller = host.controller
    val scope = rememberCoroutineScope()
    val push = state.push
    val settings = variant == PushVariant.Settings
    var panel by remember { mutableStateOf<PushPanel?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun finish() {
        scope.launch {
            busy = true
            val outcome = controller.enablePush()
            busy = false
            panel = when (outcome) {
                PushOutcome.On -> {
                    host.showToast(ConnectStrings.NUDGES_ON)
                    null
                }
                PushOutcome.Denied -> PushPanel.Denied
                PushOutcome.Unavailable -> PushPanel.Hint(ConnectStrings.PUSH_UNAVAILABLE)
                PushOutcome.ProfileNeeded -> PushPanel.Hint(ConnectStrings.PUSH_PROFILE_NEEDED)
                PushOutcome.DeleteUnfinished -> PushPanel.Hint(PeopleError.DELETE_UNFINISHED_MESSAGE)
                is PushOutcome.Failed -> PushPanel.Hint(ConnectStrings.PUSH_FAILED)
            }
        }
    }

    fun onSwitch(on: Boolean) {
        if (!on) {
            panel = null
            if (push.on) host.scope.launch { controller.disablePush() }
            return
        }
        if (!push.noticeSeen) panel = PushPanel.Notice else finish()
    }

    fun acceptNotice() {
        scope.launch {
            controller.markPushNoticeSeen()
            panel = null
            finish()
        }
    }

    val pending = panel == PushPanel.Notice || busy
    // .pp-push-panel: 10 dp between its parts, 6 dp below; in Settings inset 16 dp, 12 dp below.
    val panelPadding = if (settings) Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp) else Modifier.padding(bottom = 6.dp)
    Column(modifier.fillMaxWidth().testTag(if (settings) "push-settings" else "push-card")) {
        if (!settings) Hairline()
        Column(
            Modifier.fillMaxWidth().then(if (settings) Modifier else Modifier.padding(top = 4.dp)),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // .pp-push: the bell (card only) 8 dp before the label, "On" 10 dp before the switch.
            val showOn = push.on && panel == null
            PeopleSwitchRow(
                PeopleText.PUSH_LABEL,
                checked = push.on || pending,
                onChange = ::onSwitch,
                variant = if (settings) SwitchRowVariant.Settings else SwitchRowVariant.Presence,
                enabled = !busy,
                leading = if (settings) null else { { LucideImage(LucideIcon.BellRing, null, size = 16.dp, tint = Caddie.colors.text2) } },
                trailing = if (showOn) {
                    { Text(ConnectStrings.PUSH_ON, style = Caddie.type.meta.copy(fontWeight = FontWeight.SemiBold), color = Caddie.colors.accent) }
                } else {
                    null
                },
                rowModifier = Modifier.testTag("push-switch"),
                leadingGap = 8.dp,
                trailingGap = 10.dp,
            )
            when (val p = panel) {
                PushPanel.Notice -> Column(panelPadding, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    PeopleNotice(Modifier.testTag("push-notice")) { Text(PeopleText.PUSH_NOTICE) }
                    ActionsRow {
                        CaddieButton(ConnectStrings.TURN_ON_NUDGES, ::acceptNotice, small = true, enabled = !busy)
                        CaddieButton(ConnectStrings.NOT_NOW, { panel = null }, variant = ButtonVariant.Text, small = true, enabled = !busy)
                    }
                }
                PushPanel.Denied -> {
                    Column(panelPadding.semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        PushHint(ConnectStrings.PUSH_DENIED, settings)
                        if (host.canOpenAppSettings) CaddieButton(ConnectStrings.OPEN_SETTINGS, host::openAppSettings, variant = ButtonVariant.Text, small = true)
                    }
                }
                is PushPanel.Hint -> Column(panelPadding.semantics { liveRegion = LiveRegionMode.Polite }) {
                    if (host.opensProfile(p.text)) {
                        MessageWithLink(p.text, PeopleCommonStrings.OPEN_MY_PROFILE, host::openProfile, error = false)
                    } else {
                        PushHint(p.text, settings)
                    }
                }
                null -> Unit
            }
        }
        if (settings) SettingsTextRow(ConnectStrings.PUSH_SETTINGS_TEXT)
    }
}

/** A push hint: .pp-hint in the card, a settings text line (15 sp) in Settings. */
@Composable
private fun PushHint(text: String, settings: Boolean) {
    if (settings) Text(text, style = Caddie.type.stateBody, color = Caddie.colors.text) else HintText(text)
}
