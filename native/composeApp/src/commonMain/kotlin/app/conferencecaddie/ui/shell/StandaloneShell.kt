package app.conferencecaddie.ui.shell

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
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
 * The shell on its own, before the app talks to a backend: it remembers the theme and the server
 * typed in Settings for this run and shows no conference. Debug builds list the web app's sample
 * conferences (web/src/mock/fixtures.ts) so the shell's screens can be seen and tested. The talk
 * features replace this with state that comes from the capabilities and bundle clients.
 */
@Composable
fun StandaloneShell(isDebugBuild: Boolean) {
    var theme by rememberSaveable { mutableStateOf(ThemePreference.System) }
    var server by rememberSaveable { mutableStateOf(BuildDefaults.OFFICIAL_SERVER) }
    var conference by rememberSaveable { mutableStateOf(if (isDebugBuild) SampleData.CONFERENCES.first().id else null) }
    App(
        state = ShellState(
            capabilities = Capabilities(),
            conferences = if (isDebugBuild) SampleData.CONFERENCES else emptyList(),
            selectedConferenceId = conference,
            serverBase = server,
            officialServerBase = BuildDefaults.OFFICIAL_SERVER,
            theme = theme,
            appVersion = BuildDefaults.VERSION,
            isDebugBuild = isDebugBuild,
        ),
        actions = ShellActions(
            onSelectConference = { conference = it },
            onChangeServer = { server = it },
            onThemeChange = { theme = it },
        ),
    )
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
