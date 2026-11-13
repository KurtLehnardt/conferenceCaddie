package app.conferencecaddie.ui.people

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.layout.layout
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.people.MetPerson
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.SettingsGroup
import app.conferencecaddie.ui.components.SettingsRow
import app.conferencecaddie.ui.components.SettingsTextRow
import app.conferencecaddie.ui.theme.Caddie
import kotlinx.coroutines.launch

/**
 * The people groups of Settings (web SettingsPeople.tsx and NudgeBanner.tsx, spec section 14), in
 * the web's order, between You and Appearance: Blocked people, People I met (only when there are
 * any), People I'm watching (only when there are any), Nudges, Push (only when
 * `state.push.available`) and, native only, Bluetooth (only when `state.ble.available`). The shell draws them only while a searchable conference is selected and
 * people features are on. Each group goes straight into the Settings column, which spaces them
 * 24 dp apart, so this emits SettingsGroups without a container of its own.
 */
@Composable
fun SettingsPeople(state: PeopleUiState, host: PeopleHost) {
    BlockedPeople(state, host)
    PeopleIMet(state, host)
    PeopleIWatch(state, host)
    NudgeSettings(state, host)
}

/**
 * Blocked people: "Nobody is blocked at {conference}." or one row per `state.blocks` entry (its
 * display name, else "Someone you blocked") with an Unblock text button, disabled while its unblock
 * runs (`controller.unblock(ref)`, then the toast "Unblocked {name}", or "Unblocked" without a name;
 * a refusal shows under the rows). Reads the server's list with `controller.refreshBlocks()` when it
 * shows; the cached list stands offline.
 */
@Composable
fun BlockedPeople(state: PeopleUiState, host: PeopleHost) {
    var error by remember { mutableStateOf<String?>(null) }
    // Unblock runs on the app's scope (PeopleHost.scope), so leaving Settings meanwhile loses neither
    // its toast nor its error ([shown]); one unblock per person at a time (PeopleHost.launchOnce),
    // also across a screen that came back.
    val shown = rememberInComposition()
    LaunchedEffect(host.controller, state.conference?.slug) { host.controller.refreshBlocks() }

    SettingsGroup(ProfileStrings.BLOCKED_PEOPLE, Modifier.testTag("set-blocked")) {
        if (state.blocks.isEmpty()) {
            SettingsTextRow(ProfileStrings.nobodyBlocked(state.conference?.name ?: ""), first = true)
        } else {
            state.blocks.forEachIndexed { i, b ->
                SettingsRow(first = i == 0) {
                    Text(b.displayName ?: ProfileStrings.SOMEONE_YOU_BLOCKED, style = Caddie.type.body, color = Caddie.colors.text, modifier = Modifier.weight(1f))
                    CaddieButton(
                        ProfileStrings.UNBLOCK,
                        {
                            if (!host.isRunning("unblock:${b.ref}")) {
                                error = null
                                host.launchOnce("unblock:${b.ref}") {
                                    val err = host.controller.unblock(b.ref)
                                    when {
                                        err == null -> host.showToast(PeopleCommonStrings.unblocked(b.displayName))
                                        shown.value -> error = err
                                        else -> host.showMessage(err)
                                    }
                                }
                            }
                        },
                        Modifier.testTag("unblock-${b.ref}"),
                        variant = ButtonVariant.Text,
                        small = true,
                        enabled = !host.isRunning("unblock:${b.ref}"),
                    )
                }
            }
        }
        error?.let { message -> SettingsRow { ErrorText(message) } }
    }
}

/**
 * People I met (`state.met`, only when not empty): each name (600) and about over a Remove text
 * button that is stretched across the row with its label centred, 12 dp out to the left, as the
 * web's computed style draws it (`controller.removeMet(person)`); then "Saved on this phone only."
 * Remove goes by the entry, not its position, and is off while that entry's removal runs: a second
 * tap, even one that lands before the screen redraws, removes nobody else. A removal the phone
 * could not store leaves the entry, and a toast gives the message.
 */
@Composable
fun PeopleIMet(state: PeopleUiState, host: PeopleHost) {
    if (state.met.isEmpty()) return
    val removing = remember { mutableStateListOf<MetPerson>() }
    SettingsGroup(ProfileStrings.PEOPLE_I_MET, Modifier.testTag("set-met")) {
        state.met.forEachIndexed { i, m ->
            SettingsRow(first = i == 0) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(m.displayName, style = Caddie.type.body.copy(fontWeight = FontWeight.SemiBold), color = Caddie.colors.text)
                        if (m.about.isNotEmpty()) Text(m.about, style = Caddie.type.stateBody, color = Caddie.colors.text)
                    }
                    CaddieButton(
                        ProfileStrings.REMOVE,
                        {
                            if (m !in removing) {
                                removing += m
                                // On the app's scope, so a removal the phone could not store is told
                                // even after Settings was left; the entry then stays.
                                host.scope.launch {
                                    try {
                                        host.controller.removeMet(m)?.let(host::showMessage)
                                    } finally {
                                        removing -= m
                                    }
                                }
                            }
                        },
                        Modifier.stretchedLeft(12).testTag("met-remove-$i"),
                        variant = ButtonVariant.Text,
                        small = true,
                        enabled = m !in removing,
                    )
                }
            }
        }
        SettingsTextRow(ProfileStrings.SAVED_ON_PHONE)
    }
}

/**
 * People I'm watching (`state.watch`, only when not empty): each name (else "Someone") with Remove
 * (`controller.removeWatch(ref)`; a removal the phone could not store toasts the message), then the
 * web's footer line.
 */
@Composable
fun PeopleIWatch(state: PeopleUiState, host: PeopleHost) {
    if (state.watch.isEmpty()) return
    SettingsGroup(ProfileStrings.PEOPLE_I_WATCH, Modifier.testTag("set-watch")) {
        state.watch.forEachIndexed { i, w ->
            SettingsRow(first = i == 0) {
                Text(w.displayName.ifBlank { ProfileStrings.SOMEONE }, style = Caddie.type.body, color = Caddie.colors.text, modifier = Modifier.weight(1f))
                CaddieButton(
                    ProfileStrings.REMOVE,
                    // A removal the phone could not store leaves the row, and the toast says why.
                    { host.scope.launch { host.controller.removeWatch(w.ref)?.let(host::showMessage) } },
                    Modifier.testTag("watch-remove-${w.ref}"),
                    variant = ButtonVariant.Text,
                    small = true,
                )
            }
        }
        SettingsTextRow(ProfileStrings.WATCH_FOOTER)
    }
}

/**
 * The Nudges group (heading "Nudges") holding U3's [NudgeSetting] rows, then, when
 * `state.push.available`, the Push group (heading "Push") holding U3's [PushControls] in the
 * [PushVariant.Settings] variant, then, when `state.ble.available`, the Bluetooth group (heading
 * "Bluetooth") holding [BleControls] in the [BleVariant.Settings] variant. Nudges come only while I
 * am around, so none of the groups shows when the backend offers no presence.
 *
 * The web has no Bluetooth group: there the switch lives only in the presence card. Here it is in
 * Settings too, under a heading named after what it uses, as Push is, so it can be found and turned
 * off without the People tab.
 */
@Composable
fun NudgeSettings(state: PeopleUiState, host: PeopleHost) {
    if (!state.features.presence) return
    SettingsGroup(ProfileStrings.NUDGES, Modifier.testTag("set-nudges")) { NudgeSetting(state, host) }
    if (state.push.available) {
        SettingsGroup(ProfileStrings.PUSH, Modifier.testTag("set-push")) { PushControls(state, host, PushVariant.Settings) }
    }
    if (state.ble.available) {
        SettingsGroup(BleStrings.SETTINGS_GROUP, Modifier.testTag("set-ble")) { BleControls(state, host, BleVariant.Settings) }
    }
}

/**
 * The full width of the row plus [dp] more on the left: `.pp-met-row .btn` is stretched across its
 * column and pulled 12 px left by its negative margin, so its centred label sits 6 px left of the
 * row's middle.
 */
private fun Modifier.stretchedLeft(dp: Int): Modifier = this.layout { measurable, constraints ->
    if (!constraints.hasBoundedWidth) {
        val placeable = measurable.measure(constraints)
        return@layout layout(placeable.width, placeable.height) { placeable.place(0, 0) }
    }
    val extra = dp.dp.roundToPx()
    val width = constraints.maxWidth + extra
    val placeable = measurable.measure(constraints.copy(minWidth = width, maxWidth = width))
    layout(constraints.maxWidth, placeable.height) { placeable.place(-extra, 0) }
}
