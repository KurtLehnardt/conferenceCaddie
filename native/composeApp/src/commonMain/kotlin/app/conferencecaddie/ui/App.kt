package app.conferencecaddie.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.key
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import app.conferencecaddie.ui.components.LocalWideLayout
import app.conferencecaddie.ui.components.NavRail
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.backhandler.BackHandler
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.components.AppBar
import app.conferencecaddie.ui.components.AppBarTitle
import app.conferencecaddie.ui.components.CaddieIconButton
import app.conferencecaddie.ui.components.NavBar
import app.conferencecaddie.ui.components.NavItem
import app.conferencecaddie.ui.components.NeedsConnection
import app.conferencecaddie.ui.components.OfflineBadge
import app.conferencecaddie.ui.components.StateAction
import app.conferencecaddie.ui.components.StateView
import app.conferencecaddie.ui.components.SwitcherButton
import app.conferencecaddie.ui.components.Toast
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.shell.ConnectConfirmation
import app.conferencecaddie.ui.shell.LocalShellNavigator
import app.conferencecaddie.ui.shell.SettingsScreen
import app.conferencecaddie.ui.shell.ShellActions
import app.conferencecaddie.ui.shell.ShellNavigator
import app.conferencecaddie.ui.shell.ShellState
import app.conferencecaddie.ui.shell.SwitcherSheet
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.shell.TabContent
import app.conferencecaddie.ui.shell.isWebLink
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.CaddieTheme

/** The tabs a backend with these capabilities gets, in the tab bar's order (the web's order). */
fun visibleTabs(peopleEnabled: Boolean): List<Tab> = Tab.entries.filter { it != Tab.People || peopleEnabled }

/**
 * The root of the UI on both platforms: the web app's shell. An app bar with the conference
 * switcher, the Offline badge and the Settings gear; the tab bar (People when the backend serves
 * people features, For you, Search, Interested); Settings as a screen of its own with Back, as on
 * the web; the switcher sheet; the toast; and the confirmation before switching servers.
 *
 * In a window at least 768 dp wide (a tablet, or a phone in landscape) the shell takes the web's
 * wide layout: the tabs move to a rail on the left and the app bar and content stay in a column at
 * most 720 dp wide, centred. Every part stays clear of the system bars, the display cutout and the
 * keyboard.
 *
 * The caller owns the data ([state]) and answers [actions]; [content] supplies each tab's screen.
 * [initialTab] opens another tab than the first one, if the backend offers it. [request] moves the
 * shell from outside, once per request: to a tab or Settings (a `caddie://` link), or to the
 * conference switcher (Import my schedule's "Switch conference").
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun App(
    state: ShellState,
    actions: ShellActions = ShellActions(),
    content: TabContent = TabContent(),
    initialTab: Tab? = null,
    request: ShellRequest? = null,
) {
    val tabs = visibleTabs(state.capabilities.people.enabled)
    // The tab asked for (a tap, a link or a launch option), or null for the backend's first tab:
    // People where people features are served, else For you, as on the web. The choice is not made
    // before the capabilities arrive: on a first start the tabs appear only then, and an untouched
    // shell follows them to People, while a tab the person picked stays picked. A tab the backend
    // does not offer shows the first tab until it is offered again.
    var chosen by rememberSaveable { mutableStateOf(initialTab) }
    val selected = chosen?.takeIf { it in tabs } ?: tabs.first()
    var settingsOpen by rememberSaveable { mutableStateOf(false) }
    var switcherOpen by rememberSaveable { mutableStateOf(false) }
    // A server typed in Settings waits here for the same confirmation a link gets.
    var typedServer by rememberSaveable { mutableStateOf<String?>(null) }

    // A link's tab leaves Settings and shows the tab, as a tap on it would.
    LaunchedEffect(request) {
        val r = request ?: return@LaunchedEffect
        if (r.tab != null) {
            settingsOpen = false
            chosen = r.tab
        }
        if (r.settings) settingsOpen = true
        switcherOpen = r.switcher
    }

    val uriHandler = LocalUriHandler.current
    val openUrl: (String) -> Unit = { url ->
        if (isWebLink(url)) actions.onOpenUrl?.invoke(url) ?: runCatching { uriHandler.openUri(url) }
    }
    val navigator = remember {
        object : ShellNavigator {
            override fun selectTab(tab: Tab) {
                settingsOpen = false
                chosen = tab
            }

            override fun openSettings() {
                settingsOpen = true
            }

            override fun openSwitcher() {
                switcherOpen = true
            }
        }
    }

    // The system Back (Android) and the edge swipe (iOS) leave Settings. BackHandler is deprecated in
    // favour of the navigationevent API, which Compose Multiplatform 1.12 still marks experimental.
    @Suppress("DEPRECATION")
    BackHandler(enabled = settingsOpen) { settingsOpen = false }

    CaddieTheme(state.theme) {
        CompositionLocalProvider(LocalShellNavigator provides navigator) {
            BoxWithConstraints(Modifier.fillMaxSize().background(Caddie.colors.bg)) {
                val wide = maxWidth >= Caddie.dimens.wideLayoutMinWidth
                val navItems = tabs.map { tab -> navItem(tab, state) }
                val navSelected = if (settingsOpen) null else selected
                val onNavSelect: (Tab) -> Unit = {
                    settingsOpen = false
                    chosen = it
                }
                // The tab bar's height, so the keyboard inset below the content does not count it twice.
                var navBarHeight by remember { mutableStateOf(0.dp) }
                val density = LocalDensity.current
                // One tree for both layouts, so a screen keeps its state when the window changes width.
                CompositionLocalProvider(LocalWideLayout provides wide) {
                    Row(Modifier.fillMaxSize()) {
                        if (wide) NavRail(navItems, navSelected, onNavSelect)
                        Column(
                            Modifier
                                .weight(1f)
                                .fillMaxHeight()
                                // The rail already keeps clear of the cutout on its side.
                                .then(if (wide) Modifier.consumeWindowInsets(WindowInsets.safeDrawing.only(WindowInsetsSides.Start)) else Modifier),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            val column = if (wide) Modifier.widthIn(max = Caddie.dimens.contentMaxWidth) else Modifier
                            ShellAppBar(state, settingsOpen, selected, content, column, onBack = { settingsOpen = false }, onOpenSettings = { settingsOpen = true }, onOpenSwitcher = { switcherOpen = true })
                            Box(
                                Modifier
                                    .weight(1f)
                                    .then(column)
                                    .fillMaxWidth()
                                    .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))
                                    .then(
                                        if (wide) {
                                            Modifier.windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom))
                                        } else {
                                            Modifier.consumeWindowInsets(PaddingValues(bottom = navBarHeight))
                                        },
                                    ),
                            ) {
                                val conference = state.selectedConference
                                if (settingsOpen) {
                                    SettingsScreen(
                                        state = state,
                                        actions = actions,
                                        onOpenUrl = openUrl,
                                        onServerTyped = { typedServer = it },
                                    )
                                } else if (conference == null || !conference.searchable) {
                                    Blocker(state, actions, onChoose = { switcherOpen = true }, onOpenUrl = openUrl)
                                } else {
                                    TabBody(selected, state, content)
                                }
                                val toast = state.toast
                                if (toast != null) {
                                    Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp)) {
                                        Toast(toast, onDismiss = actions.onDismissToast, onAction = actions.onToastAction)
                                    }
                                }
                            }
                            if (!wide) {
                                NavBar(
                                    items = navItems,
                                    selected = navSelected,
                                    onSelect = onNavSelect,
                                    modifier = Modifier.onSizeChanged { navBarHeight = with(density) { it.height.toDp() } },
                                )
                            }
                        }
                    }
                }
            }

            if (switcherOpen) {
                SwitcherSheet(
                    conferences = state.conferences,
                    current = state.selectedConferenceId,
                    error = state.conferencesError,
                    onPick = {
                        switcherOpen = false
                        if (it != state.selectedConferenceId) actions.onSelectConference(it)
                    },
                    onOpenUrl = openUrl,
                    onClose = { switcherOpen = false },
                )
            }

            // A link's server and a typed server get the same confirmation, which names the base. One
            // shows at a time: a server typed in Settings is answered first (a link cannot arrive
            // before it, since the confirmation covers Settings), and a link that arrives meanwhile
            // waits for its turn instead of replacing the question the person is reading.
            val typed = typedServer
            val linked = state.pendingConnect
            val pending = when {
                typed != null -> PendingServer(typed, fromLink = false)
                linked != null -> PendingServer(linked, fromLink = true)
                else -> null
            }
            if (pending != null) {
                key(pending) {
                    ConnectConfirmation(
                        base = pending.base,
                        official = pending.base == state.officialServerBase,
                        onConfirm = {
                            if (!pending.fromLink) typedServer = null
                            actions.onChangeServer(pending.base)
                        },
                        onDecline = {
                            if (pending.fromLink) actions.onDeclineConnect() else typedServer = null
                        },
                    )
                }
            }
        }
    }
}

/**
 * A move of the shell asked from outside it: show [tab] (leaving Settings), open [settings], or open
 * the conference [switcher]. [id] tells two equal requests apart, so a second link to the tab the
 * person has since left shows it again.
 */
data class ShellRequest(val id: Long, val tab: Tab? = null, val settings: Boolean = false, val switcher: Boolean = false)

/** A server waiting for confirmation, and whether it came from a link (else from Settings). */
private data class PendingServer(val base: String, val fromLink: Boolean)

/** The app bar: the switcher (or "Settings" with Back), the tab's actions, the badge and the gear. */
@Composable
private fun ShellAppBar(
    state: ShellState,
    settingsOpen: Boolean,
    selected: Tab,
    content: TabContent,
    modifier: Modifier,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenSwitcher: () -> Unit,
) {
    AppBar(
        modifier = modifier,
        title = {
            if (settingsOpen) {
                AppBarTitle(Strings.Settings.TITLE)
            } else {
                SwitcherButton(
                    name = state.selectedConference?.name
                        ?: if (state.conferences != null) Strings.AppBar.CHOOSE_CONFERENCE else Strings.APP_NAME,
                    onClick = onOpenSwitcher,
                )
            }
        },
        leading = if (settingsOpen) {
            { CaddieIconButton(LucideIcon.ArrowLeft, Strings.AppBar.BACK, onBack, iconSize = 22.dp) }
        } else {
            null
        },
        actions = {
            // The web's order: the Offline badge, the tab's own actions, then the gear.
            if (!state.online) OfflineBadge()
            if (!settingsOpen) content.appBarActions?.invoke(selected)
            if (!settingsOpen) CaddieIconButton(LucideIcon.Settings, Strings.AppBar.SETTINGS, onOpenSettings)
        },
    )
}

private fun navItem(tab: Tab, state: ShellState): NavItem<Tab> = when (tab) {
    Tab.People -> NavItem(
        tab, Strings.Tabs.PEOPLE, LucideIcon.Users, state.peopleBadge,
        if (state.peopleBadge > 0) Strings.Tabs.peopleWithCount(state.peopleBadge) else null,
    )
    Tab.ForYou -> NavItem(tab, Strings.Tabs.FOR_YOU, LucideIcon.Sparkles)
    Tab.Search -> NavItem(tab, Strings.Tabs.SEARCH, LucideIcon.Search)
    Tab.Interested -> NavItem(
        tab, Strings.Tabs.INTERESTED, LucideIcon.Star, state.interestedCount,
        if (state.interestedCount > 0) Strings.Tabs.interestedWithCount(state.interestedCount) else null,
    )
}

@Composable
private fun TabBody(tab: Tab, state: ShellState, content: TabContent) {
    Box(Modifier.fillMaxSize().testTag("tab-body-${tab.name}")) {
        when (tab) {
            Tab.People -> content.people?.invoke() ?: PeoplePlaceholder(state.online)
            Tab.ForYou -> content.forYou?.invoke() ?: ForYouPlaceholder(state.online)
            Tab.Search -> content.search?.invoke() ?: PlaceholderScreen(LucideIcon.Search, null, Strings.Search.PLACEHOLDER)
            Tab.Interested -> content.interested?.invoke() ?: InterestedPlaceholder()
        }
    }
}

@Composable
private fun PlaceholderScreen(icon: LucideIcon, title: String?, body: String?) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        StateView(icon = icon, title = title, body = body)
    }
}

/** People until its screens arrive (phase 3), or the web's offline state. */
@Composable
fun PeoplePlaceholder(online: Boolean) {
    if (!online) {
        NeedsConnection(Strings.Offline.PEOPLE_TITLE)
    } else {
        PlaceholderScreen(LucideIcon.Users, Strings.People.PLACEHOLDER_TITLE, Strings.People.PLACEHOLDER_BODY)
    }
}

/** For you until on-device suggestions arrive (phase 2b), or the web's offline state. */
@Composable
fun ForYouPlaceholder(online: Boolean) {
    if (!online) {
        NeedsConnection(Strings.ForYou.NEEDS_CONNECTION_TITLE)
    } else {
        PlaceholderScreen(LucideIcon.Sparkles, Strings.ForYou.PICK_TITLE, Strings.ForYou.LEDE)
    }
}

/** The web's empty Interested list (web/src/components/interested.tsx). */
@Composable
fun InterestedPlaceholder() {
    val nav = LocalShellNavigator.current
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        // .screen-head and .screen-title (web/src/components/schedule.css).
        Text(
            Strings.Interested.TITLE,
            style = Caddie.type.screenTitle,
            color = Caddie.colors.text,
            modifier = Modifier
                .padding(start = Caddie.dimens.gutter, end = Caddie.dimens.gutter, top = 4.dp, bottom = 12.dp)
                .semantics { heading() },
        )
        StateView(
            icon = LucideIcon.Star,
            body = Strings.Interested.EMPTY,
            action = StateAction(Strings.Interested.FIND_TALKS, { nav.selectTab(Tab.Search) }),
            hint = {
                // "You can import your schedule in Settings", with Settings as the link, as on the web.
                val c = Caddie.colors
                val text = buildAnnotatedString {
                    append(Strings.Interested.IMPORT_HINT_PREFIX)
                    withLink(
                        LinkAnnotation.Clickable(
                            tag = "settings",
                            styles = TextLinkStyles(SpanStyle(color = c.accentInk, fontWeight = FontWeight.SemiBold, textDecoration = TextDecoration.Underline)),
                            linkInteractionListener = { nav.openSettings() },
                        ),
                    ) { append(Strings.Interested.IMPORT_HINT_LINK) }
                }
                Text(text, style = Caddie.type.meta, color = c.text2, textAlign = TextAlign.Center, modifier = Modifier.heightIn(min = Caddie.dimens.minTouch).wrapContentHeight())
            },
        )
    }
}

/** What shows instead of a conference screen when no searchable conference is selected (app.tsx). */
@Composable
private fun Blocker(state: ShellState, actions: ShellActions, onChoose: () -> Unit, onOpenUrl: (String) -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        val conference = state.selectedConference
        when {
            state.conferences == null && state.conferencesError != null -> StateView(
                icon = LucideIcon.CircleExclamationPoint,
                title = Strings.Blockers.SOMETHING_WRONG,
                body = state.conferencesError,
                action = StateAction(Strings.Blockers.RETRY, actions.onRetryConferences),
            )
            state.conferences == null -> StateView(body = Strings.Blockers.LOADING_CONFERENCES)
            conference == null -> StateView(
                icon = LucideIcon.CalendarX,
                title = if (state.selectedConferenceId == null) Strings.Blockers.NO_CONFERENCES else Strings.Blockers.NOT_AVAILABLE_HERE,
                body = Strings.Blockers.CHOOSE_ANOTHER,
                action = StateAction(Strings.Blockers.CHOOSE_CONFERENCE_BUTTON, onChoose),
            )
            else -> StateView(
                icon = LucideIcon.CalendarX,
                title = Strings.Blockers.SCHEDULE_NOT_AVAILABLE,
                body = Strings.Blockers.cantBeSearched(conference.name),
                action = conference.officialUrl?.let { url ->
                    StateAction(Strings.Blockers.OPEN_OFFICIAL, { onOpenUrl(url) }, LucideIcon.ExternalLink)
                },
            )
        }
    }
}
