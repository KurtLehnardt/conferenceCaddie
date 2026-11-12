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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.ble.BlePermissionKind
import app.conferencecaddie.shared.people.BleOutcome
import app.conferencecaddie.shared.people.BleProblem
import app.conferencecaddie.shared.people.BleView
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.Hairline
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.components.SettingsRow
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.theme.Caddie
import kotlinx.coroutines.launch

/** Where [BleControls] sits. */
enum class BleVariant {
    /** In the presence card, under the push switch and a hairline, with the Bluetooth icon (.pp-ble). */
    Card,

    /** In Settings' Bluetooth group card, in the settings rows' sizes. */
    Settings,
}

/**
 * "Find people near me by Bluetooth" (web BleControls.tsx and ble.css), only when
 * `state.ble.available`: the backend resolves derived-v1 tokens, presence is a feature there and
 * this phone has a radio that can take part. Without it nothing is drawn, as on the web outside the
 * Android app.
 *
 * The switch (`PeopleText.BLE_LABEL`) is on while `state.ble.on`, while the setup panel is open and
 * while a turn-on runs, and cannot be used while presence is off (its label then greys, as
 * .pp-ble-off). Turning it on the first time at a conference opens the setup panel:
 * `PeopleText.BLE_NOTICE`, a native line about the permission the phone will ask for
 * (`state.ble.permission`), "Turn on" (`controller.turnOnBluetooth()`, "Starting…" meanwhile) and
 * "Not now"; once the notice was accepted there (`state.ble.noticeSeen`) the switch turns it on
 * directly. Off is `controller.turnOffBluetooth()`, which also clears a problem.
 *
 * Under the switch, the web's line: "Turn on being around first." while presence is off, the
 * listening line while it runs, "Only people who also turned this on can be found." otherwise, or
 * the runtime's words for `state.ble.problem` in the error style. A screen reader hears that line
 * with the switch, as the web's aria-describedby gives it, and the setup panel's explanation is a
 * pane named "About finding people by Bluetooth" (the web's region). A refused permission and refused
 * notifications offer the system settings ([PeopleHost.openAppSettings]); on an iPhone a line says
 * that other iPhones may find it only while one of them has the app open. The runtime's own
 * messages (Bluetooth switched off, a radio that could not send) reach the person as toasts through
 * `state.notice`, which the People tab shows; this control does not repeat them.
 *
 * [variant] places it in the presence card or in Settings.
 */
@Composable
fun BleControls(state: PeopleUiState, host: PeopleHost, variant: BleVariant, modifier: Modifier = Modifier) {
    val ble = state.ble
    if (!ble.available) return
    val controller = host.controller
    val scope = rememberCoroutineScope()
    val settings = variant == BleVariant.Settings
    val presenceOn = state.presence.on
    var panel by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val starting = busy || ble.starting

    fun turnOn() {
        scope.launch {
            busy = true
            val outcome = controller.turnOnBluetooth()
            busy = false
            // A problem keeps the panel open with the words under it, as the web's error does.
            if (outcome == BleOutcome.On) panel = false
        }
    }

    fun onSwitch(on: Boolean) {
        if (!on) {
            panel = false
            // In the host's scope: the stop and its `ble: false` write finish even if the screen leaves.
            host.scope.launch { controller.turnOffBluetooth() }
            return
        }
        if (!ble.noticeSeen) panel = true else turnOn()
    }

    val c = Caddie.colors
    val labelColor = if (presenceOn) c.text else c.text2
    val hint = bleHint(ble, presenceOn)
    Column(modifier.fillMaxWidth().testTag(if (settings) "ble-settings" else "ble-card")) {
        if (!settings) Hairline()
        // .pp-ble: 8 dp under the hairline, its parts 6 dp apart. In Settings the switch row has its
        // own padding and the panel is inset as the push group's.
        Column(
            Modifier.fillMaxWidth().then(if (settings) Modifier else Modifier.padding(top = 8.dp)),
            verticalArrangement = Arrangement.spacedBy(if (settings) 8.dp else 6.dp),
        ) {
            PeopleSwitchRow(
                PeopleText.BLE_LABEL,
                // As the push switch: on while the panel asks and while it starts, so the switch does
                // not spring back while the system's permission prompt is up.
                checked = ble.on || panel || starting,
                onChange = ::onSwitch,
                variant = if (settings) SwitchRowVariant.Settings else SwitchRowVariant.Presence,
                enabled = !starting && presenceOn,
                leading = if (settings) null else { { LucideImage(LucideIcon.Bluetooth, null, size = 16.dp, tint = labelColor) } },
                rowModifier = Modifier.testTag("ble-switch").semantics {
                    // The web's aria-describedby="pp-ble-hint": the line under the switch is read with it.
                    contentDescription = BleStrings.switchDescription(hint.text)
                    if (starting) stateDescription = BleStrings.STARTING
                },
                leadingGap = 8.dp,
                labelColor = labelColor,
            )
            if (panel) {
                BleSetup(
                    ble.permission,
                    starting = starting,
                    modifier = if (settings) Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp) else Modifier,
                    onTurnOn = ::turnOn,
                    onNotNow = { panel = false },
                )
            }
            if (!settings) BleLines(ble, hint, host, settings = false)
        }
        if (settings) {
            SettingsRow {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) { BleLines(ble, hint, host, settings = true) }
            }
        }
    }
}

/** .pp-ble-setup: the explanation with the permission line, then Turn on and Not now, 10 dp apart. */
@Composable
private fun BleSetup(kind: BlePermissionKind, starting: Boolean, modifier: Modifier, onTurnOn: () -> Unit, onNotNow: () -> Unit) {
    Column(modifier.fillMaxWidth().testTag("ble-setup"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // The web's role="region" with its aria-label.
        PeopleNotice(Modifier.testTag("ble-notice").semantics { paneTitle = BleStrings.NOTICE_LABEL }) {
            Text(PeopleText.BLE_NOTICE)
            Text(BleStrings.permissionLine(kind))
        }
        ActionsRow {
            CaddieButton(
                if (starting) BleStrings.STARTING else BleStrings.TURN_ON,
                onTurnOn,
                Modifier.testTag("ble-turn-on"),
                small = true,
                enabled = !starting,
            )
            CaddieButton(ConnectStrings.NOT_NOW, onNotNow, Modifier.testTag("ble-not-now"), variant = ButtonVariant.Text, small = true, enabled = !starting)
        }
    }
}

/** #pp-ble-hint: the runtime's words for [problem] (shown in the error style), or the hint for the state. */
private class BleHint(val text: String, val problem: BleProblem?)

private fun bleHint(ble: BleView, presenceOn: Boolean): BleHint {
    // A presence problem left from an earlier attempt says nothing once presence is back on.
    val problem = ble.problem?.takeUnless { it == BleProblem.NeedsPresence && presenceOn }
    if (problem != null) return BleHint(ble.message ?: PeopleText.bleProblemMessage(problem, ble.permission), problem)
    val text = when {
        !presenceOn -> PeopleText.BLE_NEEDS_PRESENCE
        ble.on -> BleStrings.HINT_ON
        else -> BleStrings.HINT_OFF
    }
    return BleHint(text, null)
}

/**
 * The lines under the switch: #pp-ble-hint ([hint], a problem in the error style), then, while it
 * runs, the iPhone caveat and the notifications line, and "Open settings" where the system settings
 * can help.
 */
@Composable
private fun BleLines(ble: BleView, hint: BleHint, host: PeopleHost, settings: Boolean) {
    val problem = hint.problem
    BleLine(hint.text, error = problem != null, settings, Modifier.testTag("ble-hint"))
    // The permission kind is Bluetooth only on iOS.
    if (ble.on && ble.permission == BlePermissionKind.Bluetooth) BleLine(BleStrings.IOS_CAVEAT, error = false, settings, Modifier.testTag("ble-ios-caveat"))
    // Android 13 and older: no connectable set, so iPhones may not find this phone.
    if (ble.on && ble.hiddenFromIphones) BleLine(BleStrings.ANDROID_CAVEAT, error = false, settings, Modifier.testTag("ble-android-caveat"))
    val notificationsOff = ble.on && !ble.notificationsAllowed
    if (notificationsOff) BleLine(PeopleText.BLE_NOTIFICATIONS, error = true, settings, Modifier.testTag("ble-notifications"))
    // Both refusals are told "You can allow it in Settings.", so both get the way there.
    val permission = problem == BleProblem.PermissionDenied || problem == BleProblem.PermissionBlocked
    if ((permission || notificationsOff) && host.canOpenAppSettings) {
        CaddieButton(ConnectStrings.OPEN_SETTINGS, host::openAppSettings, Modifier.testTag("ble-open-settings"), variant = ButtonVariant.Text, small = true)
    }
}

/**
 * One line under the switch: .pp-hint (14 sp, secondary) or .pp-error (14 sp, danger, read out when
 * it appears) in the card; in Settings the settings text rows' 15 sp, in the text colour or danger.
 */
@Composable
private fun BleLine(text: String, error: Boolean, settings: Boolean, modifier: Modifier = Modifier) {
    val c = Caddie.colors
    Text(
        text,
        style = if (settings) Caddie.type.stateBody else Caddie.type.meta,
        color = when {
            error -> c.danger
            settings -> c.text
            else -> c.text2
        },
        modifier = modifier.then(if (error) Modifier.semantics { liveRegion = LiveRegionMode.Polite } else Modifier),
    )
}
