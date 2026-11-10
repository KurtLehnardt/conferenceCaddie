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
import app.conferencecaddie.ui.shell.ServerStatus
import app.conferencecaddie.ui.shell.ShellActions
import app.conferencecaddie.ui.shell.ShellState
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.shell.TabContent
import app.conferencecaddie.ui.shell.isWebLink
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.ThemePreference
import kotlin.time.Clock
import kotlinx.coroutines.delay

/**
 * The app on both platforms: the shell (header, switcher, tab bar, Settings) drawn from the shared
 * core's state, with the talk screens in its Search and Interested tabs. For you stays the shell's
 * placeholder until on-device recommendations arrive (phase 2b), and People appears only when the
 * backend serves people features (phase 3).
 *
 * [pendingConnect] is a backend base from a `caddie://connect` link or QR code waiting for the
 * person's confirmation; the platforms do not pass one yet.
 */
@Composable
fun CaddieApp(
    core: CaddieCore,
    isDebugBuild: Boolean,
    appVersion: String,
    pendingConnect: String? = null,
    onConnectHandled: () -> Unit = {},
    initialQuery: String? = null,
) {
    val state by core.state.collectAsState()
    val scope = rememberCoroutineScope()
    val search = remember(core) { SearchModel(scope) { core.search(it) } }
    val uriHandler = LocalUriHandler.current
    val openUrl: (String) -> Unit = { url -> if (isWebLink(url)) runCatching { uriHandler.openUri(url) } }
    var theme by remember { mutableStateOf(ThemePreference.System) }
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
    val ready = state.bundle as? BundleState.Ready
    LaunchedEffect(state.selectedSlug, ready?.bundle?.contentHash) {
        search.onConference(state.selectedSlug, ready?.bundle?.contentHash)
        cacheBytes = core.cacheSizeBytes()
    }
    LaunchedEffect(initialQuery, ready != null) {
        if (initialQuery != null && ready != null && search.input.isEmpty()) search.onInput(initialQuery)
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
            onThemeChange = { theme = it },
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
        initialTab = if (initialQuery != null) Tab.Search else null,
    )

    val talk = openTalk?.let { ready?.bundle?.talksById?.get(it) }
    if (talk != null && ready != null) {
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
