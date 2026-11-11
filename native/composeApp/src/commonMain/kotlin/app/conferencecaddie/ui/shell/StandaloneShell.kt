package app.conferencecaddie.ui.shell

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.ui.App
import app.conferencecaddie.ui.theme.ThemePreference

/** Values compiled into the builds. */
object BuildDefaults {
    /** Decision 6 (docs/NATIVE_PLAN.md): the live tier 3 server is the default backend. */
    const val OFFICIAL_SERVER = "https://conference-caddie-265846417372.us-west1.run.app"
    const val VERSION = "0.1.0"
}

/**
 * Launch options for debug builds, so screenshots and manual checks can open a given screen without
 * tapping through the app: `-caddie.tab Search`, `-caddie.open settings|switcher`,
 * `-caddie.theme light|dark`, `-caddie.connect <base>`, `-caddie.gallery 1` and
 * `-caddie.people home|around|search:<text>|profile|inbox|meet:<id>|settings-people` (iOS launch
 * arguments; Android intent extras of the same names). Release builds ignore them. `caddie.connect`
 * goes through the same BackendUrl rules as a `caddie://connect` link (https only, normalised), so it
 * can only ask the question a real link could.
 */
data class DebugLaunch(
    val tab: Tab? = null,
    val open: String? = null,
    val theme: ThemePreference? = null,
    val connect: String? = null,
    /** Shows the component gallery on the Search tab. */
    val gallery: Boolean = false,
    /** A people screen to open once people features are known (ui/people/PeopleTab.kt, `PeopleLaunch`). */
    val people: String? = null,
) {
    companion object {
        /** Reads the options from name and value pairs; unknown names and values are ignored. */
        fun from(get: (String) -> String?): DebugLaunch = DebugLaunch(
            tab = get("caddie.tab")?.let { name -> Tab.entries.firstOrNull { it.name.equals(name, ignoreCase = true) } },
            open = get("caddie.open")?.lowercase()?.takeIf { it == "settings" || it == "switcher" },
            theme = get("caddie.theme")?.let { name -> ThemePreference.entries.firstOrNull { it.name.equals(name, ignoreCase = true) } },
            connect = get("caddie.connect")?.let(::linkBase),
            gallery = get("caddie.gallery") == "1",
            people = get("caddie.people"),
        )
    }
}

/**
 * The shell on its own, before the app talks to a backend: it remembers the theme and the server
 * typed in Settings for this run and shows no conference. Debug builds list the web app's sample
 * conferences (web/src/mock/fixtures.ts) so the shell's screens can be seen and tested, and honour
 * [launch]. The talk features replace this with state that comes from the capabilities and bundle
 * clients.
 */
@Composable
fun StandaloneShell(isDebugBuild: Boolean, launch: DebugLaunch = DebugLaunch()) {
    val options = launchOptions(isDebugBuild, launch)
    var theme by rememberSaveable { mutableStateOf(options.theme ?: ThemePreference.System) }
    var server by rememberSaveable { mutableStateOf(BuildDefaults.OFFICIAL_SERVER) }
    var conference by rememberSaveable { mutableStateOf(if (isDebugBuild) SampleData.CONFERENCES.first().id else null) }
    var pending by rememberSaveable { mutableStateOf(options.connect?.let(::linkBase)) }
    var opened by rememberSaveable { mutableStateOf(options.open == null) }
    App(
        state = ShellState(
            capabilities = Capabilities(),
            conferences = if (isDebugBuild) SampleData.CONFERENCES else emptyList(),
            selectedConferenceId = conference,
            serverBase = server,
            officialServerBase = BuildDefaults.OFFICIAL_SERVER,
            theme = theme,
            appVersion = BuildDefaults.VERSION,
            pendingConnect = pending,
            isDebugBuild = isDebugBuild,
        ),
        actions = ShellActions(
            onSelectConference = { conference = it },
            onChangeServer = {
                server = it
                pending = pendingAfterSwitch(pending, it)
            },
            onDeclineConnect = { pending = null },
            onThemeChange = { theme = it },
        ),
        content = TabContent(
            search = if (options.gallery) {
                { ComponentGallery() }
            } else {
                null
            },
            appBarActions = { if (!opened) OpenOnLaunch(options.open) { opened = true } },
        ),
        initialTab = options.tab,
    )
}

/**
 * The base a `caddie://connect` link would ask about for [url], or null when the link would be
 * refused: links never get the debug exception for plain http to a local server.
 */
internal fun linkBase(url: String): String? = (BackendUrl.normalise(url, allowLocalHttp = false) as? BackendUrl.Valid)?.base

/** The launch options a build honours: all of [launch] in a debug build, none in a release build. */
internal fun launchOptions(isDebugBuild: Boolean, launch: DebugLaunch): DebugLaunch = if (isDebugBuild) launch else DebugLaunch()

// Opens Settings or the switcher once, from inside the shell where the navigator lives.
@Composable
private fun OpenOnLaunch(open: String?, onDone: () -> Unit) {
    val nav = LocalShellNavigator.current
    LaunchedEffect(open) {
        onDone()
        if (open == "settings") nav.openSettings() else if (open == "switcher") nav.openSwitcher()
    }
}

/** The web app's mock conferences (web/src/mock/fixtures.ts), for debug builds and tests. */
object SampleData {
    val CONFERENCES = listOf(
        ConferenceItem("sample-cloud-summit-2026", "Sample Cloud Summit", "Nov 9–12, 2026 · Sample City, United States"),
        ConferenceItem("sample-dev-day-nairobi-2026", "Sample Dev Day Nairobi", "Nov 19–20, 2026 · Nairobi, Kenya"),
        ConferenceItem(
            "sample-open-source-forum-2026",
            "Sample Open Source Forum",
            "Dec 7–9, 2026 · Sample Town, Japan",
            searchable = false,
            officialUrl = "https://example.invalid/sample-open-source-forum/schedule/",
        ),
        ConferenceItem(
            "sample-virtual-meetup-2027",
            "Sample Virtual Meetup",
            "Jan 20, 2027 · Virtual",
            searchable = false,
            officialUrl = "https://example.invalid/sample-virtual-meetup/",
        ),
    )
}
