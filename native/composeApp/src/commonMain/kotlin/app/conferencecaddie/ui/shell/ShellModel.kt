package app.conferencecaddie.ui.shell

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.ui.components.ToastData
import app.conferencecaddie.ui.theme.ThemePreference

/** The tab bar's destinations, in the web's order. Settings is not a tab: the gear opens it. */
enum class Tab { People, ForYou, Search, Interested }

/** A conference in the switcher. [meta] is "Nov 9–12, 2026 · Atlanta, United States". */
@Immutable
data class ConferenceItem(
    val id: String,
    val name: String,
    val meta: String,
    /** False when the schedule is not available here; the row then links to [officialUrl]. */
    val searchable: Boolean = true,
    val officialUrl: String? = null,
)

/** Whether the current server answered, for the Settings screen. */
enum class ServerStatus { Ok, Checking, Unreachable, UpdateApp }

/** One line of the "What this server offers" summary in Settings. */
@Immutable
data class SummaryRow(val label: String, val value: String)

/**
 * Everything the shell draws, owned by the caller. The shell keeps only its own navigation (the
 * selected tab, whether Settings or the switcher is open) and the drafts of its forms.
 */
@Immutable
data class ShellState(
    /** Gates the People tab: it shows only when the backend serves people features. */
    val capabilities: Capabilities = Capabilities(),
    /** Null while the list is loading. */
    val conferences: List<ConferenceItem>? = null,
    val conferencesError: String? = null,
    val selectedConferenceId: String? = null,
    /** The normalised base of the backend in use. */
    val serverBase: String = "",
    /** The build's default backend, which "Use the official server" switches back to. */
    val officialServerBase: String = "",
    val serverStatus: ServerStatus = ServerStatus.Ok,
    /** The capabilities summary in Settings; null derives a short one from [capabilities]. */
    val capabilitiesSummary: List<SummaryRow>? = null,
    val online: Boolean = true,
    val interestedCount: Int = 0,
    val peopleBadge: Int = 0,
    val theme: ThemePreference = ThemePreference.System,
    /** Bytes of saved schedules on this device; null hides the Storage group. */
    val savedSchedulesBytes: Long? = null,
    val appVersion: String = "",
    /**
     * A backend base from a deep link or QR code that waits for the person's confirmation. The
     * shell shows the confirmation while it is set; the caller clears it on either answer.
     */
    val pendingConnect: String? = null,
    val toast: ToastData? = null,
    val isDebugBuild: Boolean = false,
) {
    val selectedConference: ConferenceItem? get() = conferences?.firstOrNull { it.id == selectedConferenceId }
}

/** What the shell asks of its caller. Every callback has a harmless default. */
class ShellActions(
    val onSelectConference: (String) -> Unit = {},
    val onRetryConferences: () -> Unit = {},
    /**
     * The person confirmed switching to [base] (a normalised backend base), from Settings or from
     * a link; the same callback serves both. The caller clears [ShellState.pendingConnect] only
     * when it equals [base] (see [pendingAfterSwitch]): a link that arrived while a typed server
     * was being confirmed stays pending, and the shell asks about it next.
     */
    val onChangeServer: (base: String) -> Unit = {},
    /** The person declined the server named in [ShellState.pendingConnect]. */
    val onDeclineConnect: () -> Unit = {},
    val onThemeChange: (ThemePreference) -> Unit = {},
    val onClearSavedSchedules: () -> Unit = {},
    val onDismissToast: () -> Unit = {},
    val onToastAction: () -> Unit = {},
    /** Opens an http(s) link in the browser; the shell never passes any other scheme. */
    val onOpenUrl: ((String) -> Unit)? = null,
)

/**
 * The content of each tab, supplied by the caller. A null slot shows the shell's placeholder for
 * that tab. Slots are drawn only while a searchable conference is selected; otherwise the shell
 * shows the web's blocker states (loading, error, not available). [appBarActions] adds buttons on
 * the right of the app bar of a tab screen, after the offline badge and before the gear.
 */
class TabContent(
    val people: (@Composable () -> Unit)? = null,
    val forYou: (@Composable () -> Unit)? = null,
    val search: (@Composable () -> Unit)? = null,
    val interested: (@Composable () -> Unit)? = null,
    val appBarActions: (@Composable (Tab) -> Unit)? = null,
)

/** Lets tab content move around the shell, for example "Find talks" on an empty Interested list. */
interface ShellNavigator {
    fun selectTab(tab: Tab)
    fun openSettings()
    fun openSwitcher()
}

val LocalShellNavigator = staticCompositionLocalOf<ShellNavigator> {
    object : ShellNavigator {
        override fun selectTab(tab: Tab) = Unit
        override fun openSettings() = Unit
        override fun openSwitcher() = Unit
    }
}

/**
 * What [ShellState.pendingConnect] becomes once the person confirmed switching to [base]: cleared
 * when it was that server's link, kept when it is another one (a link that arrived while a server
 * typed in Settings was being confirmed).
 */
fun pendingAfterSwitch(pending: String?, base: String): String? = pending?.takeIf { it != base }

/** True for the only kinds of link the apps open: http and https, in any letter case. */
fun isWebLink(url: String): Boolean = Regex("^[Hh][Tt][Tt][Pp][Ss]?://").containsMatchIn(url)
