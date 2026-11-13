package app.conferencecaddie.ui.shell

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.CaddieSheet
import app.conferencecaddie.ui.components.ConfirmDialog
import app.conferencecaddie.ui.components.SegmentOption
import app.conferencecaddie.ui.components.Segmented
import app.conferencecaddie.ui.components.SettingsGroup
import app.conferencecaddie.ui.components.SettingsLinkRow
import app.conferencecaddie.ui.components.SettingsNavRow
import app.conferencecaddie.ui.components.SettingsRow
import app.conferencecaddie.ui.components.SettingsTextRow
import app.conferencecaddie.ui.components.SettingsValueRow
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.licenses.LicenceSections
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.ThemePreference

/**
 * Settings (web/src/components/settings.tsx): You, the people groups, Appearance and About as on
 * the web, plus the native apps' Server group (the backend URL, its status and what it offers) and
 * Storage group (saved schedules). A server typed here is checked by BackendUrl and then handed to
 * [onServerTyped], which shows the same confirmation a link gets.
 *
 * You holds, in the web's order, the Profile row, which [onOpenProfile] opens (left out without
 * people features), and the "Import my schedule" row when [ShellActions.onImport] is set; that row
 * is disabled, with [ShellState.importNote] as its hint, while no conference is open. Without either
 * row the group is left out. [people] draws the people groups between You and Appearance, in the
 * web's order.
 */
@Composable
fun SettingsScreen(
    state: ShellState,
    actions: ShellActions,
    onOpenUrl: (String) -> Unit,
    onServerTyped: (String) -> Unit,
    onOpenProfile: (() -> Unit)? = null,
    people: (@Composable ColumnScope.() -> Unit)? = null,
) {
    var licensesOpen by rememberSaveable { mutableStateOf(false) }
    var clearOpen by rememberSaveable { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxSize()
            // The keyboard must not cover the Server URL field: the scrolling area ends above it,
            // and the focused field scrolls into view.
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Caddie.dimens.gutter)
            .padding(bottom = 16.dp)
            .testTag("settings-screen"),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        val onImport = actions.onImport
        if (onOpenProfile != null || onImport != null) {
            SettingsGroup(Strings.Settings.YOU, Modifier.testTag("settings-you")) {
                if (onOpenProfile != null) {
                    SettingsNavRow(
                        icon = LucideIcon.UserRound,
                        label = Strings.Settings.PROFILE,
                        hint = state.profileNote ?: state.profileName.ifBlank { Strings.Settings.SET_UP_PROFILE },
                        onClick = onOpenProfile,
                        first = true,
                    )
                }
                if (onImport != null) {
                    SettingsNavRow(
                        icon = LucideIcon.FileUp,
                        label = Strings.Settings.IMPORT,
                        hint = state.importNote ?: Strings.Settings.IMPORT_HINT,
                        onClick = onImport,
                        first = onOpenProfile == null,
                        enabled = state.importNote == null,
                        modifier = Modifier.testTag("settings-import"),
                    )
                }
            }
        }
        people?.invoke(this)

        SettingsGroup(Strings.Settings.APPEARANCE) {
            SettingsRow(first = true) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(Strings.Settings.THEME, style = Caddie.type.body.copy(fontWeight = Caddie.type.chip.fontWeight), color = Caddie.colors.text)
                    Segmented(
                        options = listOf(
                            SegmentOption(ThemePreference.System, Strings.Settings.THEME_SYSTEM),
                            SegmentOption(ThemePreference.Light, Strings.Settings.THEME_LIGHT),
                            SegmentOption(ThemePreference.Dark, Strings.Settings.THEME_DARK),
                        ),
                        value = state.theme,
                        onChange = actions.onThemeChange,
                        label = Strings.Settings.THEME,
                    )
                }
            }
        }

        ServerGroup(state, actions, onServerTyped)

        val bytes = state.savedSchedulesBytes
        if (bytes != null) {
            SettingsGroup(Strings.Settings.STORAGE) {
                SettingsValueRow(Strings.Settings.SAVED_SCHEDULES, Strings.Settings.bytes(bytes), first = true)
                SettingsLinkRow(Strings.Settings.CLEAR_SAVED, LucideIcon.Trash2, { clearOpen = true }, danger = true, enabled = bytes > 0)
            }
        }

        SettingsGroup(Strings.Settings.ABOUT) {
            SettingsTextRow(Strings.Settings.ABOUT_1, first = true)
            SettingsTextRow(Strings.Settings.ABOUT_2)
            SettingsTextRow(Strings.Settings.ABOUT_3)
            SettingsLinkRow(Strings.Settings.SOURCE_CODE, LucideIcon.ExternalLink, { onOpenUrl(Strings.Settings.SOURCE_URL) })
            SettingsLinkRow(Strings.Settings.LICENSES, LucideIcon.Scale, { licensesOpen = true })
            SettingsValueRow(Strings.Settings.VERSION, state.appVersion)
        }
    }

    if (licensesOpen) {
        CaddieSheet(title = Strings.Settings.LICENSES_TITLE, onClose = { licensesOpen = false }, scrollable = false) {
            LicenceSections()
        }
    }
    if (clearOpen) {
        ConfirmDialog(
            title = Strings.Settings.CLEAR_SAVED_TITLE,
            body = Strings.Settings.CLEAR_SAVED_BODY,
            confirmLabel = Strings.Settings.CLEAR,
            onConfirm = {
                clearOpen = false
                actions.onClearSavedSchedules()
            },
            onDismiss = { clearOpen = false },
        )
    }
}

@Composable
private fun ServerGroup(state: ShellState, actions: ShellActions, onServerTyped: (String) -> Unit) {
    var draft by rememberSaveable(state.serverBase) { mutableStateOf(state.serverBase) }
    var error by remember(state.serverBase) { mutableStateOf<String?>(null) }
    val c = Caddie.colors
    val focusManager = LocalFocusManager.current
    val save = {
        when (val result = BackendUrl.normalise(draft, allowLocalHttp = state.isDebugBuild)) {
            is BackendUrl.Valid -> {
                draft = result.base
                // The keyboard goes away before the confirmation opens, so the question is asked on
                // a settled screen; a refused address keeps it, so the person can correct it.
                focusManager.clearFocus()
                if (result.base != state.serverBase) onServerTyped(result.base)
            }
            is BackendUrl.Invalid -> error = result.reason.message(state.isDebugBuild)
        }
    }
    val status = when (state.serverStatus) {
        ServerStatus.Ok -> if (state.serverBase == state.officialServerBase) Strings.Settings.OFFICIAL else Strings.Settings.using(state.serverBase)
        ServerStatus.Checking -> Strings.Settings.CHECKING
        ServerStatus.Unreachable -> Strings.Settings.UNREACHABLE
        ServerStatus.UpdateApp -> Strings.Settings.UPDATE_APP
    }
    SettingsGroup(Strings.Settings.SERVER) {
        SettingsRow(first = true) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = {
                        draft = it
                        error = null
                    },
                    label = { Text(Strings.Settings.SERVER_URL) },
                    placeholder = { Text(Strings.Settings.SERVER_PLACEHOLDER) },
                    singleLine = true,
                    isError = error != null,
                    supportingText = {
                        Text(
                            error ?: status,
                            color = when {
                                error != null -> c.danger
                                state.serverStatus == ServerStatus.Unreachable || state.serverStatus == ServerStatus.UpdateApp -> c.warning
                                else -> c.text2
                            },
                        )
                    },
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Uri,
                        imeAction = ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(onDone = { save() }),
                    shape = RoundedCornerShape(Caddie.dimens.radius),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = c.accent,
                        unfocusedBorderColor = c.borderStrong,
                        focusedLabelColor = c.accentInk,
                        cursorColor = c.accent,
                    ),
                    modifier = Modifier.fillMaxWidth().testTag("server-url"),
                )
                CaddieButton(Strings.Settings.SAVE, onClick = save, small = true, modifier = Modifier.testTag("server-save"))
            }
        }
        if (state.officialServerBase.isNotEmpty() && state.serverBase != state.officialServerBase) {
            SettingsLinkRow(Strings.Settings.USE_DEFAULT, LucideIcon.Server, { onServerTyped(state.officialServerBase) })
        }
    }
    Column(Modifier.fillMaxWidth().padding(top = 0.dp)) {
        SettingsGroup(Strings.Settings.WHAT_IT_OFFERS) {
            val rows = state.capabilitiesSummary ?: defaultSummary(state.capabilities)
            rows.forEachIndexed { i, row -> SettingsValueRow(row.label, row.value, first = i == 0) }
        }
    }
}

/** A short summary from the two flags the shell knows; the caller may pass a fuller one. */
fun defaultSummary(capabilities: Capabilities): List<SummaryRow> = listOf(
    SummaryRow(
        Strings.Settings.TIER,
        when (capabilities.tier.name) {
            "Demo" -> Strings.Settings.TIER_DEMO
            "Free" -> Strings.Settings.TIER_FREE
            "Paid" -> Strings.Settings.TIER_PAID
            else -> Strings.Settings.TIER_UNKNOWN
        },
    ),
    SummaryRow(Strings.Settings.PEOPLE, if (capabilities.people.enabled) Strings.Settings.ON else Strings.Settings.OFF),
)

/** Why a typed server address was refused, in the app's words. */
fun BackendUrl.Reason.message(isDebugBuild: Boolean): String = when (this) {
    BackendUrl.Reason.NotAUrl -> Strings.Settings.URL_NOT_A_URL
    BackendUrl.Reason.HttpsRequired -> if (isDebugBuild) Strings.Settings.URL_HTTPS_DEBUG else Strings.Settings.URL_HTTPS
    BackendUrl.Reason.CredentialsNotAllowed -> Strings.Settings.URL_CREDENTIALS
    BackendUrl.Reason.QueryNotAllowed -> Strings.Settings.URL_QUERY
}

