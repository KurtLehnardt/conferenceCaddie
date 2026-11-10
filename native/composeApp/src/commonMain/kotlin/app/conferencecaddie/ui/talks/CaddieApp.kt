package app.conferencecaddie.ui.talks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.core.BundleState
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.core.CapabilitiesState
import app.conferencecaddie.shared.core.ConferencesState
import app.conferencecaddie.shared.core.CoreState
import app.conferencecaddie.shared.core.Defaults
import app.conferencecaddie.ui.App
import app.conferencecaddie.ui.components.SkeletonCard
import app.conferencecaddie.ui.components.StateAction
import app.conferencecaddie.ui.components.StateView
import app.conferencecaddie.ui.components.ToastData
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.ServerStatus
import app.conferencecaddie.ui.shell.ShellActions
import app.conferencecaddie.ui.shell.ShellState
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.shell.TabContent
import app.conferencecaddie.ui.shell.isWebLink
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.CaddieTheme
import app.conferencecaddie.ui.theme.ThemePreference
import kotlin.time.Clock
import kotlinx.coroutines.delay

/**
 * The app on both platforms: the shell (header, switcher, tab bar, Settings) drawn from the shared
 * core's state, with the talk screens in its Search and Interested tabs. For you stays the shell's
 * placeholder until on-device recommendations arrive (phase 2b), and People appears only when the
 * backend serves people features (phase 3).
 *
 * [launch] holds the debug builds' launch options (the release hosts pass the defaults);
 * [initialQuery] types a search, which opens the Search tab, and [talkLaunch] opens a sheet or
 * marks talks, so screenshots can be taken without tapping.
 *
 * TODO(phase 3): route `caddie://connect` links and QR codes from the platforms into
 * `pendingConnect`, which already shows the confirmation that names the base.
 */
@Composable
fun CaddieApp(
    core: CaddieCore,
    isDebugBuild: Boolean,
    appVersion: String,
    launch: DebugLaunch = DebugLaunch(),
    initialQuery: String? = null,
    talkLaunch: TalkLaunch = TalkLaunch(),
) {
    val state by core.state.collectAsState()
    val scope = rememberCoroutineScope()
    val search = remember(core) { SearchModel(scope) { core.search(it) } }
    val uriHandler = LocalUriHandler.current
    val openUrl: (String) -> Unit = { url -> if (isWebLink(url)) runCatching { uriHandler.openUri(url) } }
    var theme by remember { mutableStateOf(launch.theme ?: ThemePreference.System) }
    var pendingConnect by remember { mutableStateOf(launch.connect) }
    val onConnectHandled = { pendingConnect = null }
    var openTalk by remember { mutableStateOf<String?>(null) }
    var toast by remember { mutableStateOf<ToastData?>(null) }
    var undo by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    var cacheBytes by remember { mutableStateOf<Long?>(null) }
    val nowMs by produceState(Clock.System.now().toEpochMilliseconds()) {
        while (true) {
            delay(30_000)
            value = Clock.System.now().toEpochMilliseconds()
        }
    }

    LifecycleResumeEffect(core) {
        core.refresh()
        onPauseOrDispose { }
    }
    // The theme choice is kept on this device, as the web keeps it in local storage; a debug
    // launch option wins for that run.
    LaunchedEffect(core) {
        if (launch.theme == null) {
            core.uiSetting(THEME)?.let { saved -> ThemePreference.entries.firstOrNull { it.name == saved } }?.let { theme = it }
        }
    }
    val ready = state.bundle as? BundleState.Ready
    LaunchedEffect(state.selectedSlug, ready?.bundle?.contentHash) {
        search.onConference(state.selectedSlug, ready?.bundle?.contentHash)
        cacheBytes = runCatching { core.cacheSizeBytes() }.getOrNull()
    }
    LaunchedEffect(initialQuery, ready != null) {
        if (initialQuery != null && ready != null && search.input.isEmpty()) search.onInput(initialQuery)
    }
    LaunchedEffect(talkLaunch, ready != null) {
        if (ready == null) return@LaunchedEffect
        talkLaunch.mark.forEach { if (it !in state.interested) core.setInterested(it, true) }
        if (talkLaunch.sheet == "filters") search.sheet = ""
        talkLaunch.talk?.let { openTalk = it }
    }

    val interestedIds = state.interested.toSet()
    val toggle: (Talk) -> Unit = { talk ->
        val on = talk.talkId !in interestedIds
        core.setInterested(talk.talkId, on)
        undo = talk.talkId to !on
        toast = ToastData(
            id = Clock.System.now().toEpochMilliseconds(),
            message = if (on) Strings.Toasts.ADDED else Strings.Toasts.REMOVED,
            actionLabel = Strings.Toasts.UNDO,
        )
    }

    App(
        state = shellState(state, theme, cacheBytes, isDebugBuild, appVersion, pendingConnect, toast),
        actions = ShellActions(
            onSelectConference = core::selectConference,
            onRetryConferences = { core.refresh(force = true) },
            onChangeServer = { base ->
                onConnectHandled()
                if (base == Defaults.BACKEND) {
                    core.setBackend(null)
                } else {
                    (BackendUrl.normalise(base, allowLocalHttp = isDebugBuild) as? BackendUrl.Valid)?.let { core.setBackend(it) }
                }
            },
            onDeclineConnect = onConnectHandled,
            onThemeChange = {
                theme = it
                core.setUiSetting(THEME, it.name)
            },
            onClearSavedSchedules = {
                core.clearCache()
                cacheBytes = 0
            },
            onDismissToast = { toast = null },
            onToastAction = {
                undo?.let { (id, on) -> core.setInterested(id, on) }
                undo = null
                toast = null
            },
            onOpenUrl = openUrl,
        ),
        content = TabContent(
            search = {
                BundleGate(state, core) { r ->
                    SearchScreen(search, r.bundle, interestedIds, nowMs, toggle, { openTalk = it.talkId }, openUrl)
                }
            },
            interested = {
                BundleGate(state, core) { r ->
                    InterestedScreen(r.bundle, state.interested, nowMs, toggle, { openTalk = it.talkId }, openUrl)
                }
            },
        ),
        initialTab = launch.tab ?: if (initialQuery != null) Tab.Search else null,
    )

    val talk = openTalk?.let { ready?.bundle?.talksById?.get(it) }
    if (talk != null && ready != null) {
        // The sheet sits outside App(), so it takes the same theme itself.
        CaddieTheme(theme) {
            TalkSheet(
                talk = talk,
                bundle = ready.bundle,
                related = ready.search.related(talk.talkId),
                interested = talk.talkId in interestedIds,
                nowMs = nowMs,
                onToggleInterested = toggle,
                onOpenTalk = { openTalk = it.talkId },
                onOpenUrl = openUrl,
                onClose = { openTalk = null },
            )
        }
    }
}

private const val THEME = "theme"

/**
 * Debug launch options of the talk screens: `caddie.sheet filters` opens the Filters sheet,
 * `caddie.talk <talk id>` opens a talk, and `caddie.mark <id>,<id>` marks talks. Release hosts
 * never pass them.
 */
data class TalkLaunch(val sheet: String? = null, val talk: String? = null, val mark: List<String> = emptyList()) {
    companion object {
        fun from(get: (String) -> String?) = TalkLaunch(
            sheet = get("caddie.sheet"),
            talk = get("caddie.talk"),
            mark = get("caddie.mark")?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }.orEmpty(),
        )
    }
}

/** Draws [content] once the selected conference's bundle is ready, else its loading or error state. */
@Composable
private fun BundleGate(state: CoreState, core: CaddieCore, content: @Composable (BundleState.Ready) -> Unit) {
    val name = (state.conferences as? ConferencesState.Ready)?.conferences
        ?.firstOrNull { it.conference.slug == state.selectedSlug }?.conference?.name ?: ""
    when (val b = state.bundle) {
        is BundleState.Ready -> content(b)
        BundleState.None, is BundleState.Loading -> Column(
            Modifier.fillMaxSize().padding(top = 12.dp).testTag("bundle-loading"),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            repeat(3) { SkeletonCard(Modifier.padding(horizontal = Caddie.dimens.gutter)) }
        }
        is BundleState.Failed -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag("bundle-failed")) {
            val retry = StateAction(Strings.Common.RETRY, { core.refresh(force = true) })
            when (b.reason) {
                BundleState.Reason.Offline -> StateView(
                    icon = LucideIcon.WifiOff,
                    title = Strings.Offline.NOT_SAVED_TITLE,
                    body = Strings.Offline.notSavedBody(name),
                    action = retry,
                )
                BundleState.Reason.Invalid -> StateView(
                    icon = LucideIcon.CircleExclamationPoint,
                    title = Strings.Blockers.SOMETHING_WRONG,
                    body = TalkStrings.BUNDLE_INVALID,
                    action = retry,
                )
                BundleState.Reason.UpdateApp -> StateView(
                    icon = LucideIcon.Info,
                    title = TalkStrings.UPDATE_APP_TITLE,
                    body = TalkStrings.UPDATE_APP_BODY,
                )
                BundleState.Reason.NotPublished -> StateView(
                    icon = LucideIcon.CalendarX,
                    title = Strings.Blockers.SCHEDULE_NOT_AVAILABLE,
                    body = Strings.Blockers.cantBeSearched(name),
                )
            }
        }
    }
}

private fun shellState(
    s: CoreState,
    theme: ThemePreference,
    cacheBytes: Long?,
    isDebugBuild: Boolean,
    appVersion: String,
    pendingConnect: String?,
    toast: ToastData?,
): ShellState {
    val caps = s.capabilities as? CapabilitiesState.Ready
    val conferences = when (val c = s.conferences) {
        is ConferencesState.Ready -> c.conferences.map { conferenceItem(it) }
        ConferencesState.NoBundles -> emptyList()
        is ConferencesState.Failed -> null
        ConferencesState.Loading -> null
    }
    val offline = caps?.cached == true || (s.conferences as? ConferencesState.Ready)?.offline == true ||
        (s.bundle as? BundleState.Ready)?.offline == true || s.capabilities == CapabilitiesState.Unreachable
    return ShellState(
        capabilities = caps?.forThisApp ?: Capabilities.None,
        conferences = conferences,
        conferencesError = when (val c = s.conferences) {
            is ConferencesState.Failed -> when (c.reason) {
                "update_app" -> TalkStrings.UPDATE_APP_TITLE
                "offline" -> TalkStrings.LIST_OFFLINE
                else -> TalkStrings.LIST_FAILED
            }
            else -> null
        },
        selectedConferenceId = s.selectedSlug,
        serverBase = s.backend.base,
        officialServerBase = Defaults.BACKEND,
        serverStatus = when (val c = s.capabilities) {
            CapabilitiesState.Loading -> ServerStatus.Checking
            CapabilitiesState.Unreachable -> ServerStatus.Unreachable
            CapabilitiesState.UpdateApp -> ServerStatus.UpdateApp
            is CapabilitiesState.Ready -> when {
                c.updateApp -> ServerStatus.UpdateApp
                c.cached || c.usingFallback -> ServerStatus.Unreachable
                else -> ServerStatus.Ok
            }
        },
        online = !offline,
        interestedCount = s.interested.size,
        theme = theme,
        savedSchedulesBytes = cacheBytes,
        appVersion = appVersion,
        pendingConnect = pendingConnect,
        toast = toast,
        isDebugBuild = isDebugBuild,
    )
}
