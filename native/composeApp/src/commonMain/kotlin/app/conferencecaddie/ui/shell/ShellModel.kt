package app.conferencecaddie.ui.shell

import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
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
    /**
     * False while the shell cannot tell yet whether the People tab belongs in the tab bar: on a
     * first start the capabilities are still on their way (a later start shows the stored ones at
     * once). Until then no tab is shown as selected unless the person picked one, so the app does
     * not open on For you and then move to People.
     */
    val tabsKnown: Boolean = true,
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
    /** Incoming asks waiting for an answer: the People tab's badge. */
    val peopleBadge: Int = 0,
    /** The name on this device's people profile, shown under Profile in Settings; blank says "Set up your profile". */
    val profileName: String = "",
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
 *
 * The people slots: [peoplePage] draws Profile, Requests and Meet up when the shell opens them
 * (null leaves them out, and Settings then has no You group); [settingsPeople] draws the people
 * groups of Settings (Blocked people, People I met, People I'm watching, Nudges, Push) after You,
 * while a searchable conference is selected. Its groups go straight into the Settings column, which
 * spaces them 24 dp apart.
 */
class TabContent(
    val people: (@Composable () -> Unit)? = null,
    val forYou: (@Composable () -> Unit)? = null,
    val search: (@Composable () -> Unit)? = null,
    val interested: (@Composable () -> Unit)? = null,
    val appBarActions: (@Composable (Tab) -> Unit)? = null,
    val peoplePage: (@Composable (PeoplePage) -> Unit)? = null,
    val settingsPeople: (@Composable ColumnScope.() -> Unit)? = null,
)

/**
 * A screen of its own on top of the tabs, with Back in the app bar and no tab bar selection of its
 * own: the web's non-tab routes. The shell keeps them as a stack ([ShellNavigation.pages]).
 */
sealed interface ShellPage {
    /** Settings (#/settings): the gear opens it. */
    data object Settings : ShellPage
}

/**
 * The people screens over the tabs. Requests and Meet up keep People selected in the tab bar, as
 * on the web; Profile and Settings select no tab. The caller draws them ([TabContent.peoplePage]).
 */
sealed interface PeoplePage : ShellPage {
    /** Profile (#/profile). Its Back is the labelled "‹ Settings", which leads to Settings. */
    data object Profile : PeoplePage

    /** Requests (#/inbox). */
    data object Inbox : PeoplePage

    /** Meet up (#/meet/{id}). */
    data class Meet(val meetId: String) : PeoplePage
}

/**
 * Lets content move around the shell, for example "Find talks" on an empty Interested list.
 *
 * Pages ([ShellPage]) stack over the tab screens: [openPage] puts one on top (or, when it is
 * already open, goes back to it, so Settings → Profile → "‹ Settings" returns to the Settings
 * underneath); [back] leaves the top page, as the system Back and the iOS edge swipe do;
 * [selectTab] leaves every page and shows the tab. The app bar's own Back differs, as on the web:
 * Settings, Requests and Meet up lead straight to the tab screen, and Profile leads to Settings.
 */
interface ShellNavigator {
    fun selectTab(tab: Tab)
    fun openSettings()
    fun openSwitcher()

    /** Opens [page] on top of the current screen, or goes back to it when it is already open. */
    fun openPage(page: ShellPage) = Unit

    /** Leaves the top page, if any. */
    fun back() = Unit
}

val LocalShellNavigator = staticCompositionLocalOf<ShellNavigator> {
    object : ShellNavigator {
        override fun selectTab(tab: Tab) = Unit
        override fun openSettings() = Unit
        override fun openSwitcher() = Unit
    }
}

/**
 * The shell's navigation: the tab asked for, the pages stacked over it and whether the conference
 * switcher is open. [App] makes one itself; a caller that needs to move around the shell from
 * outside it (a notification tap, a launch option) makes it with [rememberShellNavigation] and
 * passes it in. It survives configuration changes and process death on Android.
 */
@Stable
class ShellNavigation(initialTab: Tab? = null) : ShellNavigator {
    /**
     * The tab last asked for (a tap, a link, a notification or a launch option), or null for the
     * first one offered: People when the backend serves people features, else For you. Null is
     * never fixed on a start tab, so People opens when the capabilities arrive after the first
     * screen, and a tab the person picked is never replaced. While the backend does not offer the
     * tab asked for (People without people features), the shell shows its first tab, and returns to
     * this one once it is offered again.
     */
    var tab: Tab? by mutableStateOf(initialTab)
        private set

    /** The pages over the tab screen, bottom first; empty on a tab screen. */
    var pages: List<ShellPage> by mutableStateOf(emptyList())
        private set

    var switcherOpen: Boolean by mutableStateOf(false)

    /** The page showing, or null on a tab screen. */
    val top: ShellPage? get() = pages.lastOrNull()

    override fun selectTab(tab: Tab) {
        pages = emptyList()
        this.tab = tab
    }

    override fun openSettings() = openPage(ShellPage.Settings)

    override fun openSwitcher() {
        switcherOpen = true
    }

    override fun openPage(page: ShellPage) {
        val i = pages.indexOf(page)
        pages = if (i >= 0) pages.take(i + 1) else pages + page
    }

    override fun back() {
        pages = pages.dropLast(1)
    }

    /**
     * The app bar's Back (web app.tsx `backTo`): Profile leads to Settings (back to the one
     * underneath, or a new one on top, as the web's link does); every other page leads to the tab.
     */
    fun appBarBack() {
        if (top == PeoplePage.Profile) openPage(ShellPage.Settings) else pages = emptyList()
    }

    /** Closes the pages [which] selects, wherever they are in the stack. */
    fun closePages(which: (ShellPage) -> Boolean) {
        if (pages.any(which)) pages = pages.filterNot(which)
    }

    companion object {
        private fun encode(page: ShellPage): String = when (page) {
            ShellPage.Settings -> "settings"
            PeoplePage.Profile -> "profile"
            PeoplePage.Inbox -> "inbox"
            is PeoplePage.Meet -> "meet:${page.meetId}"
        }

        private fun decode(value: String): ShellPage? = when {
            value == "settings" -> ShellPage.Settings
            value == "profile" -> PeoplePage.Profile
            value == "inbox" -> PeoplePage.Inbox
            value.startsWith("meet:") -> PeoplePage.Meet(value.removePrefix("meet:"))
            else -> null
        }

        /** Saves the tab, the switcher and the pages as strings, which every platform can keep. */
        val Saver: Saver<ShellNavigation, Any> = listSaver(
            save = { nav -> listOf(nav.tab?.name ?: "", nav.switcherOpen.toString()) + nav.pages.map(::encode) },
            restore = { saved ->
                ShellNavigation(Tab.entries.firstOrNull { it.name == saved[0] }).apply {
                    switcherOpen = saved[1] == "true"
                    pages = saved.drop(2).mapNotNull(::decode)
                }
            },
        )
    }
}

/** A [ShellNavigation] kept across recomposition and configuration changes, starting on [initialTab]. */
@Composable
fun rememberShellNavigation(initialTab: Tab? = null): ShellNavigation =
    rememberSaveable(saver = ShellNavigation.Saver) { ShellNavigation(initialTab) }

/**
 * What [ShellState.pendingConnect] becomes once the person confirmed switching to [base]: cleared
 * when it was that server's link, kept when it is another one (a link that arrived while a server
 * typed in Settings was being confirmed).
 */
fun pendingAfterSwitch(pending: String?, base: String): String? = pending?.takeIf { it != base }

/** True for the only kinds of link the apps open: http and https, in any letter case. */
fun isWebLink(url: String): Boolean = Regex("^[Hh][Tt][Tt][Pp][Ss]?://").containsMatchIn(url)
