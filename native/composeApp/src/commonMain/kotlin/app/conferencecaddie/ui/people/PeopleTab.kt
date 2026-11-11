package app.conferencecaddie.ui.people

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.referentialEqualityPolicy
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.AppLink
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.people.PeopleAvailability
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.ui.ShellRequest
import app.conferencecaddie.ui.components.CaddieIconButton
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.components.NeedsConnection
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.shell.PeoplePage
import app.conferencecaddie.ui.shell.ShellNavigation
import app.conferencecaddie.ui.shell.ShellState
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import kotlinx.coroutines.flow.first

// The People layer: how the people screens sit in the shell. The screens themselves are
// PeopleScreen (the People tab), ProfileScreen, InboxScreen and MeetScreen (the pages over the
// tabs), SettingsPeople (in Settings), TalkPeopleControls (in the talk sheet), ShareAllControls (on
// Interested), and the sheets every screen shares (AskSheet, ReportSheet, the block confirmation).
// Each takes the PeopleUiState it draws and the PeopleHost; nothing reaches the controller through
// a CompositionLocal.

/**
 * The People tab. Offline it is the web's NeedsConnection ("People to meet needs a connection");
 * online, once people features are on and a conference is ready, U2's [PeopleScreen] with the
 * request a notification or another screen left in [PeopleHost.request]. Without people features
 * the shell hides the tab altogether.
 */
@Composable
fun PeopleTab(state: PeopleUiState, host: PeopleHost, talks: PeopleTalks, online: Boolean, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize()) {
        when {
            !online -> PeopleOffline()
            state.features.enabled && state.availability == PeopleAvailability.Ready -> Box(Modifier.fillMaxSize().testTag("people-home")) {
                PeopleScreen(state, host, talks, host.request)
            }
            // Loading, Off and NoConference: the shell hides the tab or shows its blocker.
            else -> Unit
        }
    }
}

/**
 * A people page over the tabs: Profile (works offline, as on the web), Requests and Meet up (the
 * web's NeedsConnection while offline). The shell draws the conference blocker instead while no
 * searchable conference is selected.
 */
@Composable
fun PeoplePageContent(page: PeoplePage, state: PeopleUiState, host: PeopleHost, talks: PeopleTalks, online: Boolean) {
    when (page) {
        PeoplePage.Profile -> ProfileScreen(state, host, talks)
        PeoplePage.Inbox -> if (online) InboxScreen(state, host) else PeopleOffline()
        is PeoplePage.Meet -> if (online) key(page.meetId) { MeetScreen(page.meetId, state, host) } else PeopleOffline()
    }
}

/** The sheets and the dialog that more than one people screen opens, drawn once: AskSheet, ReportSheet and the block confirmation. */
@Composable
fun PeopleSheets(state: PeopleUiState, host: PeopleHost) {
    val asking = host.asking
    // After an activity's re-creation only the ref of the person asked of comes back; the sheet
    // drops if the controller no longer knows them once it has finished loading.
    val unknown = host.askingRef != null && asking == null && state.availability != PeopleAvailability.Loading
    LaunchedEffect(unknown) {
        if (unknown) host.closeAsk()
    }
    asking?.let { person -> AskSheet(person, state, host, onClose = host::closeAsk) }
    host.reporting?.let { target -> ReportSheet(target, host, onClose = host::closeReport) }
    host.blocking?.let { target -> BlockConfirmDialog(target.name, onConfirm = { host.block(target) }, onDismiss = host::closeBlock) }
}

/**
 * The Requests button of the People tab's app bar (app.tsx .appbar-inbox): the inbox icon, named
 * "Requests" or "Requests, {n} new", with the count badge (99+ above 99) 4 dp from the top and
 * 24 dp from the left, ringed in the surface colour.
 */
@Composable
fun RequestsButton(count: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    CaddieIconButton(LucideIcon.Inbox, Strings.AppBar.requests(count), onClick, modifier.testTag("requests-button"), badge = count)
}

/** The web's offline state of the People tab, Requests and Meet up. */
@Composable
private fun PeopleOffline() {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag("people-offline")) {
        NeedsConnection(Strings.Offline.PEOPLE_TITLE, Strings.Offline.NEEDS_CONNECTION_BODY)
    }
}

/** .offline-note in a talk card: "Talk circles need a connection." with the wifi-off icon, for an Interested talk while offline. */
@Composable
private fun CirclesOfflineNote() {
    Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        LucideImage(LucideIcon.WifiOff, null, size = 14.dp)
        Text(Strings.Talk.CIRCLES_OFFLINE, style = Caddie.type.note, color = Caddie.colors.text2)
    }
}

/**
 * The people features as the app hands them to the shell for one composition: the shell's People
 * values ([shellState]), its slots ([tab], [page], [settings], [appBarActions]), the talk screens'
 * slots ([talkControls], [shareAll]) and the shared sheets ([Sheets]). [rememberPeopleUi] makes it.
 */
class PeopleUi internal constructor(
    val state: PeopleUiState,
    val host: PeopleHost,
    talks: PeopleTalks,
    private val online: Boolean,
    searchable: Boolean,
    private val slots: PeopleSlots = PeopleSlots(host),
) {
    init {
        slots.update(PeopleInputs(state, talks, online, searchable))
    }

    /** True while the backend offers people features to this app (and over https, outside debug builds). */
    val enabled: Boolean get() = state.features.enabled

    private val ready: Boolean get() = enabled && state.availability == PeopleAvailability.Ready

    /** Incoming asks waiting for an answer: the badge of the People tab and of Requests. */
    val badge: Int get() = if (enabled) state.inbox.count else 0

    /**
     * [base] with the People tab shown only when the controller has people features on too (so the
     * tab and the screens agree), the tab's badge and the profile name for Settings.
     */
    fun shellState(base: ShellState): ShellState = base.copy(
        capabilities = base.capabilities.copy(people = base.capabilities.people.copy(enabled = base.capabilities.people.enabled && enabled)),
        // The tab bar is known once the controller has answered too, so a start that has the
        // capabilities already does not select For you for the moment the controller takes.
        tabsKnown = base.tabsKnown && !(base.capabilities.people.enabled && state.availability == PeopleAvailability.Loading),
        peopleBadge = badge,
        profileName = state.profile.displayName,
    )

    /** TabContent.people. */
    val tab: @Composable () -> Unit get() = slots.tab

    /** TabContent.peoplePage. */
    val page: @Composable (PeoplePage) -> Unit get() = slots.page

    /** TabContent.settingsPeople: the people groups, once a conference is ready. */
    val settings: @Composable ColumnScope.() -> Unit get() = slots.settings

    /** TabContent.appBarActions: Requests on the People tab. */
    val appBarActions: @Composable (Tab) -> Unit get() = slots.appBarActions

    /**
     * TalkSheet's `peopleControls`: online, U1's [TalkPeopleControls]; offline, "Talk circles need a
     * connection." for an Interested talk; null without people features. The lambda is the same
     * instance across recompositions (it reads the latest state itself), so lists that take it can
     * skip.
     */
    val talkControls: (@Composable (Talk) -> Unit)? get() = if (ready) slots.talkControls else null

    /** InterestedScreen's `shareAll`: U1's [ShareAllControls], online with people features on, else null. Stable like [talkControls]. */
    val shareAll: (@Composable (List<String>) -> Unit)? get() = if (online && ready) slots.shareAll else null

    /** True while one of the shared sheets or the block confirmation is open. */
    val hasSheet: Boolean get() = host.asking != null || host.reporting != null || host.blocking != null

    /** The shared sheets; draw them once, outside the shell, in the app's theme. */
    @Composable
    fun Sheets() = PeopleType { PeopleSheets(state, host) }
}

/** What the People layer's slots read: one value, so a slot changes by reading it and not by being made again. */
internal class PeopleInputs(
    val state: PeopleUiState,
    val talks: PeopleTalks,
    val online: Boolean,
    val searchable: Boolean,
)

/**
 * The slots of [PeopleUi] as lambdas that live as long as the [PeopleHost]. Each reads the latest
 * [PeopleInputs] when it runs, so a new state recomposes what it draws, while the lambda itself stays
 * the same instance and does not make the lists that hold it recompose.
 */
internal class PeopleSlots(private val host: PeopleHost) {
    private val latest = mutableStateOf<PeopleInputs?>(null, referentialEqualityPolicy())

    fun update(inputs: PeopleInputs) {
        latest.value = inputs
    }

    private fun inputs(): PeopleInputs = checkNotNull(latest.value)

    val tab: @Composable () -> Unit = {
        val i = inputs()
        PeopleType { PeopleTab(i.state, host, i.talks, i.online) }
    }

    val page: @Composable (PeoplePage) -> Unit = { page ->
        val i = inputs()
        PeopleType { PeoplePageContent(page, i.state, host, i.talks, i.online) }
    }

    val settings: @Composable ColumnScope.() -> Unit = {
        val i = inputs()
        if (i.state.features.enabled && i.state.availability == PeopleAvailability.Ready) PeopleType { SettingsPeople(i.state, host) }
    }

    val appBarActions: @Composable (Tab) -> Unit = { tab ->
        val i = inputs()
        if (tab == Tab.People && i.state.features.enabled && i.searchable) {
            RequestsButton(if (i.state.features.enabled) i.state.inbox.count else 0, host::openInbox)
        }
    }

    val talkControls: @Composable (Talk) -> Unit = { talk ->
        val i = inputs()
        val interested = talk.talkId in i.talks.interested
        PeopleType { if (i.online) TalkPeopleControls(talk.talkId, interested, i.state, host) else if (interested) CirclesOfflineNote() }
    }

    val shareAll: @Composable (List<String>) -> Unit = { ids ->
        val i = inputs()
        PeopleType { ShareAllControls(ids, i.state, host) }
    }
}

/**
 * The People layer for [controller], or null without one (no people features in this host). It
 * collects the controller's state; makes the [PeopleHost] (toasts through [showToast], talks
 * through [openTalk], links through [openUrl], moves through [navigation]); shows the people route
 * of the shell's [request] (`ShellRequest.people`: a link from another app or a QR code, or a
 * tapped notification's `caddie://people?around=1`, `caddie://inbox` or `caddie://meet/{id}`, all
 * read by `AppLink`) and the debug [launch] option once people features are on; and toasts the
 * controller's notices.
 */
@Composable
fun rememberPeopleUi(
    controller: PeopleController?,
    navigation: ShellNavigation,
    talks: PeopleTalks,
    online: Boolean,
    searchable: Boolean,
    launch: PeopleLaunch?,
    showToast: (message: String, actionLabel: String?, action: (() -> Unit)?) -> Unit,
    openTalk: (talkId: String) -> Unit,
    openUrl: (url: String) -> Unit,
    request: ShellRequest? = null,
): PeopleUi? {
    if (controller == null) return null
    val state by controller.state.collectAsState()
    val scope = rememberCoroutineScope()
    val toast by rememberUpdatedState(showToast)
    val talkOpener by rememberUpdatedState(openTalk)
    val urlOpener by rememberUpdatedState(openUrl)
    val memory = rememberSaveable(saver = PeopleHostMemory.Saver) { PeopleHostMemory() }
    val host = remember(controller, navigation, memory) {
        PeopleHost(
            controller = controller,
            navigator = navigation,
            scope = scope,
            toast = { message, action -> toast(message, action?.label, action?.onClick) },
            openTalk = { talkOpener(it) },
            openUrl = { urlOpener(it) },
            memory = memory,
        )
    }
    val enabled by rememberUpdatedState(state.features.enabled)

    // A people route waits until people features are on, so the notification tap or link that
    // opened the app is not lost while the capabilities load; it is then shown once. The hand-off
    // gave it up when the app took it, so it waits here; a newer request replaces one still waiting.
    var routed by remember { mutableStateOf(0L) }
    LaunchedEffect(host, request) {
        val r = request ?: return@LaunchedEffect
        val people = r.people ?: return@LaunchedEffect
        if (r.id == routed) return@LaunchedEffect
        snapshotFlow { enabled }.first { it }
        routed = r.id
        route(people, host, navigation)
    }

    var launched by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(host, launch) {
        if (launch == null || launched) return@LaunchedEffect
        snapshotFlow { enabled }.first { it }
        launched = true
        when (launch) {
            is PeopleLaunch.Route -> route(launch.route, host, navigation)
            is PeopleLaunch.Search -> host.openPeople(PeopleRequest(query = launch.text))
            PeopleLaunch.SettingsPeople -> navigation.openSettings()
        }
    }

    // Work the controller did by itself (an automatic share as talks are marked) reports here, as
    // the web's toast does, with "Open profile" when the controller says the fix is on the profile.
    LaunchedEffect(state.notice) {
        val notice = state.notice ?: return@LaunchedEffect
        if (notice.opensProfile) {
            toast(notice.message, PeopleCommonStrings.OPEN_PROFILE, host::openProfile)
        } else {
            toast(notice.message, null, null)
        }
        controller.clearNotice()
    }

    val slots = remember(host) { PeopleSlots(host) }
    return PeopleUi(state, host, talks, online, searchable, slots)
}

/**
 * Shows [route]. Requests and Meet up open over the People tab, so Back returns there; Profile opens
 * over whatever shows, as from Settings on the web; a zone opens People with the presence setup on
 * that zone, which turns nothing on until the person taps "I'm around" (PresenceControls).
 */
private fun route(route: AppLink.PeopleRoute, host: PeopleHost, navigation: ShellNavigation) {
    when (route) {
        is AppLink.PeopleRoute.Home -> host.openPeople(if (route.aroundNow) PeopleRequest(aroundNow = true) else null)
        AppLink.PeopleRoute.Inbox -> {
            navigation.selectTab(Tab.People)
            host.openInbox()
        }
        is AppLink.PeopleRoute.Meet -> {
            navigation.selectTab(Tab.People)
            host.openMeet(route.meetId)
        }
        AppLink.PeopleRoute.Profile -> host.openProfile()
        is AppLink.PeopleRoute.Here -> host.openPeople(PeopleRequest(hereZone = route.zone))
    }
}
