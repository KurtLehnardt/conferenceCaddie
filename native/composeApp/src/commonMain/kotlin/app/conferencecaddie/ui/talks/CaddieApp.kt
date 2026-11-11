package app.conferencecaddie.ui.talks

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import app.conferencecaddie.shared.AppLink
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.ConnectLink
import app.conferencecaddie.shared.bundle.Conference
import app.conferencecaddie.shared.bundle.TalkTime
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.Embedder
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.core.BundleState
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.core.CapabilitiesState
import app.conferencecaddie.shared.core.ConferencesState
import app.conferencecaddie.shared.core.CoreState
import app.conferencecaddie.shared.core.Defaults
import app.conferencecaddie.shared.core.SemanticState
import app.conferencecaddie.ui.App
import app.conferencecaddie.ui.ShellRequest
import app.conferencecaddie.ui.components.ConfirmDialog
import app.conferencecaddie.ui.components.MenuItem
import app.conferencecaddie.ui.components.OverflowMenu
import app.conferencecaddie.ui.platform.Incoming
import app.conferencecaddie.ui.platform.IncomingHandoff
import app.conferencecaddie.ui.platform.PlatformActions
import app.conferencecaddie.ui.components.LucideImage
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
import app.conferencecaddie.ui.shell.pendingAfterSwitch
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.CaddieTheme
import app.conferencecaddie.ui.theme.ThemePreference
import kotlin.time.Clock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay

/**
 * The app on both platforms: the shell (header, switcher, tab bar, Settings) drawn from the shared
 * core's state, with the talk screens in its For you, Search and Interested tabs. People appears only
 * when the backend serves people features (phase 3).
 *
 * [embedder] loads the query embedder; the hosts pass [EmbeddingModel.load], the shipped model. Search
 * and For you use keywords alone until it is loaded, for good if it returns null or fails, and
 * without one (the UI tests that do not need it).
 *
 * [launch] holds the debug builds' launch options (the release hosts pass the defaults);
 * [initialQuery] types a search, which opens the Search tab, and [talkLaunch] opens a sheet or
 * marks talks, so screenshots can be taken without tapping.
 *
 * [platform] is the system's file picker and share sheet. Links and files the platform hands over
 * ([IncomingHandoff]) are routed here: a `caddie://connect` link (or the QR code that holds one)
 * asks the shell's confirmation that names the server, a `caddie://e/...` link opens a conference's
 * tab, view and day as the web's routes do, and a schedule file opens Import my schedule.
 */
@Composable
fun CaddieApp(
    core: CaddieCore,
    isDebugBuild: Boolean,
    appVersion: String,
    launch: DebugLaunch = DebugLaunch(),
    initialQuery: String? = null,
    talkLaunch: TalkLaunch = TalkLaunch(),
    embedder: (suspend () -> Embedder?)? = null,
    platform: PlatformActions = PlatformActions.None,
) {
    val state by core.state.collectAsState()
    // The screens' models run in this scope. The core searches and works out For you off the main
    // thread; the main dispatcher brings each model back to the main thread before it changes
    // what the screens show, whatever dispatcher the composition has (a UI test's would otherwise
    // go on in the core's thread, and Compose would not hear of the change).
    val scope = rememberCoroutineScope { Dispatchers.Main.immediate }
    // The Search screen's state outlives the composition while its owner lives (the activity across
    // a rotation on Android); without an owner it lives as long as this composition.
    val owner = LocalViewModelStoreOwner.current
    val search = if (owner != null) {
        viewModel(viewModelStoreOwner = owner, key = "search") { SearchViewModel(scope) { core.search(it) } }.model
    } else {
        remember(core) { SearchModel(scope) { core.search(it) } }
    }
    SideEffect { search.attach(scope) }
    val schedule = if (owner != null) {
        viewModel(viewModelStoreOwner = owner, key = "schedule") { ScheduleViewModel(scope) { core.search(it) } }.model
    } else {
        remember(core) { ScheduleModel(scope) { core.search(it) } }
    }
    SideEffect { schedule.attach(scope) }
    var searchView by rememberSaveable { mutableStateOf(SearchView.Search) }
    // My schedule's List or Day choice is kept on this device, as the web keeps it in local storage;
    // the Day view's day belongs to its conference.
    var myView by remember { mutableStateOf(MyScheduleView.List) }
    var myDay by rememberSaveable { mutableStateOf<String?>(null) }
    var myDaySlug by rememberSaveable { mutableStateOf<String?>(null) }
    var clearOpen by rememberSaveable { mutableStateOf(false) }
    var shellRequest by remember { mutableStateOf<ShellRequest?>(null) }
    // Each request to the shell gets the next number, so two equal requests are told apart.
    val requestIds = remember { RequestIds() }
    // Import my schedule: the core imports on the device or through the backend, as its
    // capabilities say.
    val importer = if (owner != null) {
        viewModel(viewModelStoreOwner = owner, key = "import") { ImportViewModel(scope) { core.importSchedule(it) } }.model
    } else {
        remember(core) { ImportModel(scope) { core.importSchedule(it) } }
    }
    SideEffect { importer.attach(scope) }
    var importOpen by rememberSaveable { mutableStateOf(false) }
    // A file opened in the app before its conference's schedule is ready waits for it.
    var pendingFile by remember { mutableStateOf<Incoming.File?>(null) }
    var importSlug by remember { mutableStateOf<String?>(null) }
    var pendingOpen by remember { mutableStateOf<AppLink.Open?>(null) }
    val forYou = remember(core) { ForYouModel(scope) { core.forYou(ForYouModel.SIZE) } }
    var pickerOpen by remember { mutableStateOf(false) }
    val uriHandler = LocalUriHandler.current
    val openUrl: (String) -> Unit = { url -> if (isWebLink(url)) runCatching { uriHandler.openUri(url) } }
    var theme by remember { mutableStateOf(launch.theme ?: ThemePreference.System) }
    var pendingConnect by remember { mutableStateOf(launch.connect) }
    val onConnectHandled = { pendingConnect = null }
    var openTalk by rememberSaveable { mutableStateOf<String?>(null) }
    var toast by remember { mutableStateOf<ToastData?>(null) }
    // What the toast's Undo does.
    var undo by remember { mutableStateOf<(() -> Unit)?>(null) }
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
    // The core loads the model in the background when a search first needs it; the search runs again
    // once the model is ready, so the meaning-based list joins what is on screen, or once it failed,
    // so the results say they are keyword matches.
    LaunchedEffect(core) { if (embedder != null) core.useEmbedder(embedder) }
    LaunchedEffect(state.semantic) {
        if (state.semantic == SemanticState.Ready || state.semantic == SemanticState.Unavailable) search.submit()
    }
    // The theme choice is kept on this device, as the web keeps it in local storage; a debug
    // launch option wins for that run.
    LaunchedEffect(core) {
        if (launch.theme == null) {
            core.uiSetting(THEME)?.let { saved -> ThemePreference.entries.firstOrNull { it.name == saved } }?.let { theme = it }
        }
        if (core.uiSetting(MY_SCHEDULE_VIEW) == "day") myView = MyScheduleView.Day
    }
    val ready = state.bundle as? BundleState.Ready
    LaunchedEffect(state.selectedSlug, ready?.bundle?.contentHash) {
        search.onConference(state.selectedSlug, ready?.bundle?.contentHash)
        schedule.onConference(state.selectedSlug)
        cacheBytes = runCatching { core.cacheSizeBytes() }.getOrNull()
    }
    LaunchedEffect(initialQuery, ready != null) {
        if (initialQuery != null && ready != null && search.input.isEmpty()) search.onInput(initialQuery)
    }
    LaunchedEffect(talkLaunch, ready != null) {
        if (ready == null) return@LaunchedEffect
        talkLaunch.mark.forEach { if (it !in state.interested) core.setInterested(it, true) }
        if (talkLaunch.learn != null) core.setLearnTopics(talkLaunch.learn)
        talkLaunch.learnText?.let { core.setLearnText(it) }
        if (talkLaunch.sheet == "filters") search.sheet = ""
        if (talkLaunch.sheet == "topics") pickerOpen = true
        if (talkLaunch.sheet == "import") {
            importer.reset()
            importOpen = true
        }
        if (talkLaunch.sheet == "clear") clearOpen = true
        talkLaunch.importText?.let { text ->
            importer.reset()
            importer.pasteOpen = true
            importer.pasteText = text
            importOpen = true
            importer.runText(state.interested.toSet())
        }
        talkLaunch.talk?.let { openTalk = it }
    }
    // caddie.link hands a link over as the platform would, so the routing can be tried without one.
    LaunchedEffect(talkLaunch.link) { talkLaunch.link?.let { IncomingHandoff.offerLink(it) } }
    // For you asks again whenever what it depends on changes, and every minute, as talks end, but
    // only while it is on screen (the effect lives in its tab); coming back to it catches up.
    // A model given back for memory (Ready to Idle) changes nothing For you shows, so it does not ask
    // again then. Idle before the model was ever ready is another matter: the first Ready must refresh.
    var modelWasReady by remember { mutableStateOf(false) }
    LaunchedEffect(state.semantic) { if (state.semantic == SemanticState.Ready) modelWasReady = true }
    val forYouSemantic = if (state.semantic == SemanticState.Idle && modelWasReady) SemanticState.Ready else state.semantic
    val forYouInputs = listOf(ready?.bundle?.contentHash, state.learn, state.interested, forYouSemantic, nowMs / 60_000)

    // The person is told once when the stored data could not be opened.
    LaunchedEffect(state.storageReset) {
        if (state.storageReset) {
            val message = if (state.storageInMemory) TalkStrings.STORAGE_IN_MEMORY else TalkStrings.STORAGE_RESET
            toast = ToastData(id = Clock.System.now().toEpochMilliseconds(), message = message)
            core.dismissStorageReset()
        }
    }

    val interestedIds = state.interested.toSet()
    val interestedTalks = state.interestedTalks()
    val showToast: (String, (() -> Unit)?) -> Unit = { message, onUndo ->
        undo = onUndo
        toast = ToastData(
            id = Clock.System.now().toEpochMilliseconds(),
            message = message,
            actionLabel = if (onUndo != null) Strings.Toasts.UNDO else null,
        )
    }
    val toggle: (Talk) -> Unit = { talk ->
        val on = talk.talkId !in interestedIds
        core.setInterested(talk, on)
        showToast(if (on) Strings.Toasts.ADDED else Strings.Toasts.REMOVED) { core.setInterested(talk, !on) }
    }

    // Links and files from the platform, each handled once, in the order they came.
    val incoming by IncomingHandoff.latest.collectAsState()
    LaunchedEffect(incoming) {
        val item = incoming ?: return@LaunchedEffect
        IncomingHandoff.take(item)
        when (item) {
            is Incoming.Link -> when (val link = AppLink.parse(item.url)) {
                // A connect link only ever asks; a refused one (not https, credentials, a query) is
                // dropped without a word, as the web drops it.
                is AppLink.Connect -> (link.link as? ConnectLink.Confirm)?.let { pendingConnect = it.backend.base }
                is AppLink.Open -> pendingOpen = link
                null -> Unit
            }
            // A file opened in or shared to the app opens Import my schedule with it.
            is Incoming.File -> pendingFile = item
        }
    }
    LaunchedEffect(pendingFile, ready != null) {
        val item = pendingFile ?: return@LaunchedEffect
        if (ready == null) return@LaunchedEffect
        pendingFile = null
        toast = null
        if (item.picked) {
            // Chosen in the app's own picker: read at once, as it would have been.
            importer.reset()
            importOpen = true
            importer.runFile(item.file, state.interested.toSet())
        } else {
            // From another app: the sheet opens with the file waiting, read only when the person
            // taps Find talks.
            importer.offer(item.file)
            importOpen = true
        }
    }
    // Another conference closes Import my schedule, as a route change closes the web's sheet.
    LaunchedEffect(state.selectedSlug) {
        if (importSlug != null && importSlug != state.selectedSlug) importOpen = false
        importSlug = state.selectedSlug
    }
    // A conference link waits for the conference list, selects its conference if the backend lists
    // it, then shows its tab, view and day.
    val conferenceList = state.conferences
    LaunchedEffect(pendingOpen, conferenceList, state.selectedSlug) {
        val link = pendingOpen ?: return@LaunchedEffect
        val slug = link.slug
        if (slug != null && slug != state.selectedSlug) {
            when (conferenceList) {
                ConferencesState.Loading -> return@LaunchedEffect
                is ConferencesState.Ready -> if (conferenceList.conferences.any { it.conference.slug == slug }) {
                    core.selectConference(slug)
                    return@LaunchedEffect
                }
                else -> Unit
            }
            pendingOpen = null
            showToast(Strings.Blockers.NOT_AVAILABLE_HERE, null)
            return@LaunchedEffect
        }
        pendingOpen = null
        val on = state.selectedSlug
        when (link.tab) {
            AppLink.Tab.Search -> {
                schedule.onConference(on)
                if (link.view == AppLink.View.Schedule || (link.view == null && link.day != null)) searchView = SearchView.Schedule
                if (link.view == AppLink.View.Search) searchView = SearchView.Search
                link.day?.let { schedule.day = it }
            }
            AppLink.Tab.Interested -> {
                link.view?.let { myView = if (it == AppLink.View.Day) MyScheduleView.Day else MyScheduleView.List }
                link.day?.let {
                    myDay = it
                    myDaySlug = on
                }
            }
            else -> Unit
        }
        shellRequest = ShellRequest(
            id = ++requestIds.last,
            tab = when (link.tab) {
                AppLink.Tab.People -> Tab.People
                AppLink.Tab.ForYou -> Tab.ForYou
                AppLink.Tab.Search -> Tab.Search
                AppLink.Tab.Interested -> Tab.Interested
                AppLink.Tab.Settings, null -> null
            },
            settings = link.tab == AppLink.Tab.Settings,
        )
    }

    App(
        state = shellState(state, interestedTalks.size, theme, cacheBytes, isDebugBuild, appVersion, pendingConnect, toast)
            .copy(importNote = if (ready == null) Strings.Settings.IMPORT_NEEDS_CONFERENCE else null),
        actions = ShellActions(
            onSelectConference = core::selectConference,
            onRetryConferences = { core.refresh(force = true) },
            onChangeServer = { base ->
                // A server from a link or QR code never gets the debug builds' local http exception;
                // only one typed in Settings does. A link's base is always https, so a typed http
                // base is never taken for it. A link that arrived while a typed server was being
                // confirmed stays pending (pendingAfterSwitch), and the shell asks about it next.
                val fromLink = base == pendingConnect
                pendingConnect = pendingAfterSwitch(pendingConnect, base)
                if (base == Defaults.BACKEND) {
                    core.setBackend(null)
                } else {
                    (BackendUrl.normalise(base, allowLocalHttp = isDebugBuild && !fromLink) as? BackendUrl.Valid)?.let {
                        core.setBackend(it, typed = !fromLink)
                    }
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
                undo?.invoke()
                undo = null
                toast = null
            },
            onOpenUrl = openUrl,
            onImport = {
                toast = null
                importer.reset()
                importOpen = true
            },
        ),
        content = TabContent(
            forYou = {
                BundleGate(state, core) { r ->
                    LaunchedEffect(forYouInputs) { forYou.refresh(state.selectedSlug, forYouInputs) }
                    ForYouScreen(
                        model = forYou,
                        bundle = r.bundle,
                        learnTopics = state.learn.topics,
                        interested = interestedIds,
                        onToggleInterested = toggle,
                        onOpenTalk = { openTalk = it.talkId },
                        onOpenUrl = openUrl,
                        onPickTopics = { pickerOpen = true },
                    )
                }
            },
            search = {
                BundleGate(state, core) { r ->
                    SearchTab(
                        view = searchView,
                        onView = { searchView = it },
                        search = {
                            SearchScreen(search, r.bundle, interestedIds, nowMs, toggle, { openTalk = it.talkId }, openUrl, openRank = talkLaunch.rank)
                        },
                        schedule = {
                            ScheduleScreen(schedule, r.bundle, interestedIds, nowMs, toggle) { openTalk = it.talkId }
                        },
                    )
                }
            },
            interested = {
                BundleGate(state, core) { r ->
                    InterestedScreen(
                        r.bundle, state.interested, nowMs, toggle, { openTalk = it.talkId }, openUrl, state.interestedSnapshots,
                        view = myView,
                        onView = {
                            myView = it
                            core.setUiSetting(MY_SCHEDULE_VIEW, if (it == MyScheduleView.Day) "day" else "list")
                        },
                        day = myDay.takeIf { myDaySlug == state.selectedSlug },
                        onDay = {
                            myDay = it
                            myDaySlug = state.selectedSlug
                        },
                    )
                }
            },
            appBarActions = { tab ->
                // web app.tsx: the Interested tab's options, while a schedule is open.
                if (tab == Tab.Interested && ready != null) {
                    OverflowMenu(
                        label = Strings.AppBar.INTERESTED_OPTIONS,
                        startOpen = talkLaunch.sheet == "menu",
                        items = listOf(
                            MenuItem(
                                Strings.Share.SHARE_LIST,
                                onSelect = {
                                    val conference = ready.bundle.conference
                                    platform.shareText(shareText(conference, interestedTalks), Strings.Share.subject(conference.name))
                                },
                                enabled = interestedTalks.isNotEmpty(),
                                testTag = "menu-share",
                            ),
                            MenuItem(
                                Strings.AppBar.CLEAR_LIST,
                                onSelect = {
                                    toast = null
                                    clearOpen = true
                                },
                                destructive = true,
                                enabled = interestedTalks.isNotEmpty(),
                                testTag = "menu-clear",
                            ),
                        ),
                    )
                }
            },
        ),
        initialTab = launch.tab ?: if (initialQuery != null) Tab.Search else null,
        request = shellRequest,
    )

    if (importOpen && ready != null) {
        CaddieTheme(theme) {
            ImportSheet(
                model = importer,
                conference = ready.bundle.conference,
                interested = interestedIds,
                onPickFile = {
                    platform.pickScheduleFile { file -> if (file != null) importer.runFile(file, state.interested.toSet()) }
                },
                onMark = { talks ->
                    // The device list only; nothing is shared (web markImported).
                    val have = state.interested.toSet()
                    val added = talks.filter { it.talkId !in have && it.talkId.substringBefore(':') == state.selectedSlug }
                    if (added.isNotEmpty()) core.setInterested(added, true)
                    added.map { it.talkId }
                },
                onUndo = { ids -> core.setInterested(ids.mapNotNull { id -> ready.bundle.talksById[id] }, false) },
                onViewSchedule = { day ->
                    importOpen = false
                    myView = MyScheduleView.Day
                    core.setUiSetting(MY_SCHEDULE_VIEW, "day")
                    myDay = day
                    myDaySlug = state.selectedSlug
                    shellRequest = ShellRequest(id = ++requestIds.last, tab = Tab.Interested)
                },
                onSwitchConference = {
                    importOpen = false
                    shellRequest = ShellRequest(id = ++requestIds.last, switcher = true)
                },
                onClose = { importOpen = false },
            )
        }
    }

    if (clearOpen) {
        val n = interestedTalks.size
        CaddieTheme(theme) {
            ConfirmDialog(
                title = Strings.Interested.CLEAR_TITLE,
                body = Strings.Interested.clearBody(n),
                confirmLabel = Strings.Interested.CLEAR,
                onConfirm = {
                    clearOpen = false
                    val before = interestedTalks
                    core.setInterested(before, false)
                    showToast(Strings.Toasts.CLEARED) { core.setInterested(before, true) }
                },
                onDismiss = { clearOpen = false },
                testTag = "clear-dialog",
            )
        }
    }

    if (pickerOpen && ready != null) {
        CaddieTheme(theme) {
            TopicPickerSheet(
                bundle = ready.bundle,
                selected = state.learn.topics,
                text = state.learn.text,
                interested = state.interested,
                onTopics = core::setLearnTopics,
                onText = core::setLearnText,
                onClose = { pickerOpen = false },
            )
        }
    }

    // A marked talk the bundle no longer holds opens from its saved copy.
    val talk = openTalk?.let { id -> ready?.bundle?.talksById?.get(id) ?: interestedTalks.firstOrNull { it.talkId == id } }
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

/** The last id given to a [ShellRequest]. */
private class RequestIds {
    var last = 0L
}

/** The List or Day choice of My schedule (the web's caddie.myschedule.view.v1). */
private const val MY_SCHEDULE_VIEW = "myschedule.view.v1"

/**
 * My schedule as text for the share sheet (native only; the web has no share of the list): the
 * talks by day in the conference's local time (in marking order at the same start, as My schedule
 * lists them), each with its room and official link, and the time zone they are written in.
 */
internal fun shareText(conference: Conference, talks: List<Talk>): String {
    val sorted = talks.sortedBy { it.startEpochMs }
    if (sorted.isEmpty()) return Strings.Share.subject(conference.name)
    return buildString {
        append(Strings.Share.subject(conference.name)).append('\n')
        sorted.groupBy { it.day }.forEach { (day, list) ->
            append('\n').append(TalkTime.dayLong(day)).append('\n')
            list.forEach { t ->
                append(TalkTime.timeRange(t.startMinutes, t.endMinutes)).append("  ").append(t.title).append('\n')
                val meta = listOfNotNull(t.speakers.joinToString(", ").takeIf { it.isNotEmpty() }, t.room?.takeIf { it.isNotEmpty() })
                if (meta.isNotEmpty()) append("  ").append(meta.joinToString(" · ")).append('\n')
                t.url?.takeIf { isWebLink(it) }?.let { append("  ").append(it).append('\n') }
            }
        }
        append('\n').append(Strings.Share.footer(TalkTime.zoneLabel(conference.timeZone, sorted.first().start)))
    }
}

/**
 * Debug launch options of the talk screens: `caddie.sheet filters` opens the Filters sheet,
 * `caddie.sheet topics` the topic picker, `caddie.sheet import` Import my schedule, `caddie.sheet
 * menu` the Interested options and `caddie.sheet clear` the Clear list question, `caddie.talk <talk id>` opens a talk, `caddie.mark
 * <id>,<id>` marks talks, `caddie.learn <topic id>,<topic id>` and `caddie.learnText <text>` set
 * what For you suggests from, and `caddie.rank first` (or a talk id) opens that search result's Why
 * this rank, `caddie.link <caddie:// link>` hands a link over as the platform would, and
 * `caddie.importText <text>` imports the text as if pasted (`\n` for a new line). Release
 * hosts never pass them.
 */
data class TalkLaunch(
    val sheet: String? = null,
    val talk: String? = null,
    val mark: List<String> = emptyList(),
    val learn: List<String>? = null,
    val learnText: String? = null,
    val rank: String? = null,
    val link: String? = null,
    val importText: String? = null,
) {
    companion object {
        fun from(get: (String) -> String?) = TalkLaunch(
            sheet = get("caddie.sheet"),
            talk = get("caddie.talk"),
            mark = list(get("caddie.mark")).orEmpty(),
            learn = list(get("caddie.learn")),
            learnText = get("caddie.learnText"),
            rank = get("caddie.rank"),
            link = get("caddie.link"),
            importText = get("caddie.importText")?.replace("\\n", "\n"),
        )

        private fun list(value: String?) = value?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }
    }
}

/** Draws [content] once the selected conference's bundle is ready, else its loading or error state. */
@Composable
private fun BundleGate(state: CoreState, core: CaddieCore, content: @Composable (BundleState.Ready) -> Unit) {
    val name = (state.conferences as? ConferencesState.Ready)?.conferences
        ?.firstOrNull { it.conference.slug == state.selectedSlug }?.conference?.name ?: ""
    when (val b = state.bundle) {
        is BundleState.Ready -> Column(Modifier.fillMaxSize()) {
            if (b.updateApp || (state.conferences as? ConferencesState.Ready)?.updateApp == true) UpdateNotice()
            content(b)
        }
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

/** The notice above the talk screens when the schedule shown is the last one this app could read. */
@Composable
private fun UpdateNotice() {
    val c = Caddie.colors
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Caddie.dimens.gutter)
            .padding(top = 4.dp, bottom = 8.dp)
            .background(c.fill, RoundedCornerShape(Caddie.dimens.radius))
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .testTag("update-notice")
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LucideImage(LucideIcon.Info, null, size = 18.dp, tint = c.text2)
        Text(TalkStrings.UPDATE_APP_NOTICE, style = Caddie.type.meta, color = c.text2, modifier = Modifier.weight(1f))
    }
}

private fun shellState(
    s: CoreState,
    interestedCount: Int,
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
    // A stored copy shown while the backend is asked again, or because it needs a newer app, is not
    // "offline".
    val offline = (caps?.cached == true && !caps.checking && !caps.updateApp) || (s.conferences as? ConferencesState.Ready)?.offline == true ||
        (s.bundle as? BundleState.Ready)?.offline == true || s.capabilities == CapabilitiesState.Unreachable
    return ShellState(
        capabilities = caps?.forThisApp ?: Capabilities.None,
        conferences = conferences,
        conferencesError = when (val c = s.conferences) {
            is ConferencesState.Failed -> when (c.reason) {
                // The server itself, or only its conference list, needs a newer app.
                "update_app" -> if (s.capabilities == CapabilitiesState.UpdateApp) TalkStrings.SERVER_UPDATE_APP else TalkStrings.UPDATE_APP_TITLE
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
                c.checking -> ServerStatus.Checking
                c.cached || c.usingFallback -> ServerStatus.Unreachable
                else -> ServerStatus.Ok
            }
        },
        online = !offline,
        interestedCount = interestedCount,
        theme = theme,
        savedSchedulesBytes = cacheBytes,
        appVersion = appVersion,
        pendingConnect = pendingConnect,
        toast = toast,
        isDebugBuild = isDebugBuild,
    )
}
