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
import app.conferencecaddie.shared.AppLink
import app.conferencecaddie.ui.components.LocalNarrowLayout
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
import androidx.compose.runtime.SideEffect
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
import app.conferencecaddie.ui.components.AppBarBack
import app.conferencecaddie.ui.components.AppBarLabeledBack
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
import app.conferencecaddie.ui.shell.PeoplePage
import app.conferencecaddie.ui.shell.SettingsScreen
import app.conferencecaddie.ui.shell.ShellActions
import app.conferencecaddie.ui.shell.ShellNavigation
import app.conferencecaddie.ui.shell.ShellPage
import app.conferencecaddie.ui.shell.ShellState
import app.conferencecaddie.ui.shell.SwitcherSheet
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.shell.TabContent
import app.conferencecaddie.ui.shell.isWebLink
import app.conferencecaddie.ui.shell.rememberShellNavigation
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.CaddieTheme
import kotlinx.coroutines.delay

/** The tabs a backend with these capabilities gets, in the tab bar's order (the web's order). */
fun visibleTabs(peopleEnabled: Boolean): List<Tab> = Tab.entries.filter { it != Tab.People || peopleEnabled }

/**
 * How long the tab bar waits for the capabilities on a first start before it shows the tabs it
 * has. People comes first, as on the web, so if it arrived after the tabs were drawn every other
 * tab would move from under a finger: a tap meant for Search would land on For you.
 */
const val TABS_WAIT_MS = 2_000L

/**
 * The root of the UI on both platforms: the web app's shell. An app bar with the conference
 * switcher, the Offline badge and the Settings gear; the tab bar (People when the backend serves
 * people features, For you, Search, Interested); the pages over the tabs (Settings, and the people
 * screens Profile, Requests and Meet up), each with Back, as on the web; the switcher sheet; the
 * toast; and the confirmation before switching servers.
 *
 * In a window at least 768 dp wide (a tablet, or a phone in landscape) the shell takes the web's
 * wide layout: the tabs move to a rail on the left and the app bar and content stay in a column at
 * most 720 dp wide, centred. Every part stays clear of the system bars, the display cutout and the
 * keyboard.
 *
 * The caller owns the data ([state]) and answers [actions]; [content] supplies each tab's screen and
 * the people pages. [initialTab] opens another tab than the first one, if the backend offers it.
 * [navigation] holds where the shell is; pass one from [rememberShellNavigation] to move around the
 * shell from outside it. [request] moves the shell from outside too, once per request: to a tab or
 * Settings (a `caddie://` link), or to the conference switcher (Import my schedule's "Switch
 * conference").
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun App(
    state: ShellState,
    actions: ShellActions = ShellActions(),
    content: TabContent = TabContent(),
    initialTab: Tab? = null,
    navigation: ShellNavigation = rememberShellNavigation(initialTab),
    request: ShellRequest? = null,
) {
    val peopleEnabled = state.capabilities.people.enabled
    val tabs = visibleTabs(peopleEnabled)
    // Tier 1 has no People tab and opens on For you. A tab that is not offered (People, when the
    // backend turns people features off) falls back to the first one. Nothing is picked for the
    // person before the tabs are known: on a first start the tab bar shows no selection until the
    // capabilities say whether People is there, and then the first tab.
    val picked = navigation.tab?.takeIf { it in tabs }
    val selected = picked ?: tabs.first()
    val tabSelected = picked ?: tabs.first().takeIf { state.tabsKnown }
    val page = navigation.top
    // A page opened over a tab screen remembers which one it was (Profile's Back names it).
    SideEffect { navigation.shownTab = selected }
    // The tab bar keeps its place but draws no tab until it is known whether People is among them
    // (on a first start, and while the people controller opens its records), or until TABS_WAIT_MS
    // has passed, so no tab moves once the person can see it.
    var tabsWaitOver by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(TABS_WAIT_MS)
        tabsWaitOver = true
    }
    val tabsShown = state.tabsKnown || tabsWaitOver
    // A server typed in Settings waits here for the same confirmation a link gets.
    var typedServer by rememberSaveable { mutableStateOf<String?>(null) }

    // The people pages close when the backend is known to serve no people features. Requests and
    // Meet up belong to one conference, so they close when another conference is selected, as on
    // the web. After a restore the capabilities are still loading (features read as off) and the
    // conference is not selected yet; neither closes a page. Only a settled "off", and a real switch
    // from one conference to another, do.
    LaunchedEffect(peopleEnabled, state.tabsKnown) {
        if (state.tabsKnown && !peopleEnabled) navigation.closePages { it is PeoplePage }
    }
    var shownConference by rememberSaveable { mutableStateOf(state.selectedConferenceId) }
    LaunchedEffect(state.selectedConferenceId) {
        val selected = state.selectedConferenceId ?: return@LaunchedEffect
        val shown = shownConference
        if (shown != null && shown != selected) {
            navigation.closePages { it == PeoplePage.Inbox || it is PeoplePage.Meet }
            navigation.conferenceChanged()
        }
        shownConference = selected
    }
    // A link's tab leaves every page and shows the tab, as a tap on it would; a link to Settings opens
    // it as the gear does. The switcher shows only when the request asks for it. A people route is
    // the People layer's to show (see ShellRequest).
    LaunchedEffect(request) {
        val r = request ?: return@LaunchedEffect
        if (r.people == null) r.tab?.let(navigation::selectTab)
        if (r.settings) navigation.openSettings()
        navigation.switcherOpen = r.switcher
    }

    val uriHandler = LocalUriHandler.current
    val openUrl: (String) -> Unit = { url ->
        if (isWebLink(url)) actions.onOpenUrl?.invoke(url) ?: runCatching { uriHandler.openUri(url) }
    }

    // The system Back (Android) and the edge swipe (iOS) leave the top page. BackHandler is
    // deprecated in favour of the navigationevent API, which Compose Multiplatform 1.12 still marks
    // experimental.
    @Suppress("DEPRECATION")
    BackHandler(enabled = page != null) { navigation.back() }

    CaddieTheme(state.theme) {
        CompositionLocalProvider(LocalShellNavigator provides navigation) {
            BoxWithConstraints(Modifier.fillMaxSize().background(Caddie.colors.bg)) {
                val wide = maxWidth >= Caddie.dimens.wideLayoutMinWidth
                val navItems = if (tabsShown) tabs.map { tab -> navItem(tab, state) } else emptyList()
                // Requests and Meet up belong to People, as on the web; Profile to the tab its Back
                // names, if any; Settings to no tab.
                val navSelected = when (page) {
                    null -> tabSelected
                    PeoplePage.Inbox, is PeoplePage.Meet -> Tab.People.takeIf { it in tabs }
                    PeoplePage.Profile -> navigation.profileBackTab?.takeIf { it in tabs }
                    else -> null
                }
                val onNavSelect: (Tab) -> Unit = navigation::selectTab
                // The tab bar's height, so the keyboard inset below the content does not count it twice.
                var navBarHeight by remember { mutableStateOf(0.dp) }
                val density = LocalDensity.current
                // One tree for both layouts, so a screen keeps its state when the window changes width.
                CompositionLocalProvider(LocalWideLayout provides wide, LocalNarrowLayout provides (maxWidth < Caddie.dimens.narrowAppBarMaxWidth)) {
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
                            ShellAppBar(state, page, selected, content, column, navigation)
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
                                val searchable = conference != null && conference.searchable
                                when {
                                    page == ShellPage.Settings -> SettingsScreen(
                                        state = state,
                                        actions = actions,
                                        onOpenUrl = openUrl,
                                        onServerTyped = { typedServer = it },
                                        onOpenProfile = if (content.peoplePage != null && peopleEnabled) {
                                            { navigation.openPage(PeoplePage.Profile) }
                                        } else {
                                            null
                                        },
                                        people = content.settingsPeople.takeIf { searchable && peopleEnabled },
                                    )
                                    !searchable -> Blocker(state, actions, onChoose = { navigation.switcherOpen = true }, onOpenUrl = openUrl)
                                    page is PeoplePage -> Box(Modifier.fillMaxSize().testTag("page-${pageTag(page)}")) {
                                        content.peoplePage?.invoke(page)
                                    }
                                    else -> TabBody(selected, state, content)
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
                                    modifier = Modifier
                                        .testTag(if (state.tabsKnown) "tabs-known" else "tabs-pending")
                                        .onSizeChanged { navBarHeight = with(density) { it.height.toDp() } },
                                )
                            }
                        }
                    }
                }
            }

            if (navigation.switcherOpen) {
                SwitcherSheet(
                    conferences = state.conferences,
                    current = state.selectedConferenceId,
                    error = state.conferencesError,
                    onPick = {
                        navigation.switcherOpen = false
                        if (it != state.selectedConferenceId) actions.onSelectConference(it)
                    },
                    onOpenUrl = openUrl,
                    onClose = { navigation.switcherOpen = false },
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
 * person has since left shows it again. [people] is the People screen a link names (Requests, a
 * meet, the profile, a zone, or the home with "Around now"), which comes with [tab] People. The
 * People layer (rememberPeopleUi) shows it, tab and page together, once people features are on;
 * the shell leaves the tab alone for such a request, so the tab and the page change at once and a
 * route that waits for the people features does not move the shell meanwhile.
 */
data class ShellRequest(
    val id: Long,
    val tab: Tab? = null,
    val settings: Boolean = false,
    val switcher: Boolean = false,
    val people: AppLink.PeopleRoute? = null,
)

/** A server waiting for confirmation, and whether it came from a link (else from Settings). */
private data class PendingServer(val base: String, val fromLink: Boolean)

/**
 * The app bar: the switcher on a tab screen, or the page's title with its Back; the Offline badge,
 * the tab's own buttons and the gear.
 */
@Composable
private fun ShellAppBar(
    state: ShellState,
    page: ShellPage?,
    selected: Tab,
    content: TabContent,
    modifier: Modifier,
    navigation: ShellNavigation,
) {
    AppBar(
        modifier = modifier,
        title = {
            if (page != null) {
                AppBarTitle(pageTitle(page))
            } else {
                SwitcherButton(
                    name = state.selectedConference?.name
                        ?: if (state.conferences != null) Strings.AppBar.CHOOSE_CONFERENCE else Strings.APP_NAME,
                    onClick = { navigation.switcherOpen = true },
                )
            }
        },
        leading = when (page) {
            null -> null
            PeoplePage.Profile -> {
                {
                    val back = navigation.profileBackTab
                    if (back != null) {
                        AppBarLabeledBack(tabName(back), Strings.AppBar.backTo(tabName(back)), navigation::appBarBack)
                    } else {
                        AppBarLabeledBack(Strings.AppBar.BACK_SETTINGS_LABEL, Strings.AppBar.BACK_TO_SETTINGS, navigation::appBarBack)
                    }
                }
            }
            else -> {
                { AppBarBack(navigation::appBarBack) }
            }
        },
        actions = {
            // The web's order: the Offline badge, the tab's own buttons, the gear.
            if (!state.online) OfflineBadge()
            if (page == null) {
                content.appBarActions?.invoke(selected)
                CaddieIconButton(LucideIcon.Settings, Strings.AppBar.SETTINGS, navigation::openSettings)
            }
        },
    )
}

/** The app bar title of a page (app.tsx). */
private fun pageTitle(page: ShellPage): String = when (page) {
    ShellPage.Settings -> Strings.Settings.TITLE
    PeoplePage.Profile -> Strings.AppBar.PROFILE
    PeoplePage.Inbox -> Strings.AppBar.REQUESTS
    is PeoplePage.Meet -> Strings.AppBar.MEET_UP
}

/** The test tag of a people page's body: page-profile, page-inbox or page-meet. */
private fun pageTag(page: PeoplePage): String = when (page) {
    PeoplePage.Profile -> "profile"
    PeoplePage.Inbox -> "inbox"
    is PeoplePage.Meet -> "meet"
}

/** A tab's name in the tab bar, which Profile's Back also says. */
private fun tabName(tab: Tab): String = when (tab) {
    Tab.People -> Strings.Tabs.PEOPLE
    Tab.ForYou -> Strings.Tabs.FOR_YOU
    Tab.Search -> Strings.Tabs.SEARCH
    Tab.Interested -> Strings.Tabs.INTERESTED
}

private fun navItem(tab: Tab, state: ShellState): NavItem<Tab> = when (tab) {
    Tab.People -> NavItem(
        tab, tabName(tab), LucideIcon.Users, state.peopleBadge,
        if (state.peopleBadge > 0) Strings.Tabs.peopleWithCount(state.peopleBadge) else null,
    )
    Tab.ForYou -> NavItem(tab, tabName(tab), LucideIcon.Sparkles)
    Tab.Search -> NavItem(tab, tabName(tab), LucideIcon.Search)
    Tab.Interested -> NavItem(
        tab, tabName(tab), LucideIcon.Star, state.interestedCount,
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
