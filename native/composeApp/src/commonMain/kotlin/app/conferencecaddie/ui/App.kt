package app.conferencecaddie.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.components.AppBar
import app.conferencecaddie.ui.components.AppBarTitle
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
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
 * The caller owns the data ([state]) and answers [actions]; [content] supplies each tab's screen.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun App(
    state: ShellState,
    actions: ShellActions = ShellActions(),
    content: TabContent = TabContent(),
) {
    val tabs = visibleTabs(state.capabilities.people.enabled)
    // Tier 1 has no People tab and opens on For you.
    var selected by rememberSaveable { mutableStateOf(tabs.first()) }
    var settingsOpen by rememberSaveable { mutableStateOf(false) }
    var switcherOpen by rememberSaveable { mutableStateOf(false) }
    // A server typed in Settings waits here for the same confirmation a link gets.
    var typedServer by rememberSaveable { mutableStateOf<String?>(null) }

    // If People disappears while selected (the backend changed), fall back to the first tab.
    LaunchedEffect(tabs) {
        if (selected !in tabs) selected = tabs.first()
    }

    val uriHandler = LocalUriHandler.current
    val openUrl: (String) -> Unit = { url ->
        if (isWebLink(url)) actions.onOpenUrl?.invoke(url) ?: runCatching { uriHandler.openUri(url) }
    }
    val navigator = remember {
        object : ShellNavigator {
            override fun selectTab(tab: Tab) {
                settingsOpen = false
                selected = tab
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
            Column(Modifier.fillMaxSize().background(Caddie.colors.bg)) {
                val conference = state.selectedConference
                AppBar(
                    title = {
                        if (settingsOpen) {
                            AppBarTitle(Strings.Settings.TITLE)
                        } else {
                            SwitcherButton(
                                name = conference?.name
                                    ?: if (state.conferences != null) Strings.AppBar.CHOOSE_CONFERENCE else Strings.APP_NAME,
                                onClick = { switcherOpen = true },
                            )
                        }
                    },
                    leading = if (settingsOpen) {
                        { CaddieIconButton(LucideIcon.ArrowLeft, Strings.AppBar.BACK, { settingsOpen = false }, iconSize = 22.dp) }
                    } else {
                        null
                    },
                    actions = {
                        if (!settingsOpen) content.appBarActions?.invoke(selected)
                        if (!state.online) OfflineBadge()
                        if (!settingsOpen) CaddieIconButton(LucideIcon.Settings, Strings.AppBar.SETTINGS, { settingsOpen = true })
                    },
                )
                Box(Modifier.weight(1f).fillMaxWidth()) {
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
                NavBar(
                    items = tabs.map { tab -> navItem(tab, state) },
                    selected = if (settingsOpen) null else selected,
                    onSelect = {
                        settingsOpen = false
                        selected = it
                    },
                )
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

            // A link's server and a typed server get the same confirmation, which names the base.
            val pending = state.pendingConnect ?: typedServer
            if (pending != null) {
                ConnectConfirmation(
                    base = pending,
                    official = pending == state.officialServerBase,
                    onConfirm = {
                        typedServer = null
                        actions.onChangeServer(pending)
                    },
                    onDecline = {
                        if (state.pendingConnect != null) actions.onDeclineConnect()
                        typedServer = null
                    },
                )
            }
        }
    }
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
            Tab.People -> content.people?.invoke() ?: if (!state.online) {
                NeedsConnection(Strings.Offline.PEOPLE_TITLE)
            } else {
                PlaceholderScreen(LucideIcon.Users, Strings.People.PLACEHOLDER_TITLE, Strings.People.PLACEHOLDER_BODY)
            }
            Tab.ForYou -> content.forYou?.invoke() ?: if (!state.online) {
                NeedsConnection(Strings.ForYou.NEEDS_CONNECTION_TITLE)
            } else {
                PlaceholderScreen(LucideIcon.Sparkles, Strings.ForYou.PICK_TITLE, Strings.ForYou.LEDE)
            }
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

/** The web's empty Interested list (web/src/components/interested.tsx). */
@Composable
fun InterestedPlaceholder() {
    val nav = LocalShellNavigator.current
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Text(
            Strings.Interested.TITLE,
            style = Caddie.type.appBarTitle.copy(fontSize = Caddie.type.sheetTitle.fontSize),
            color = Caddie.colors.text,
            modifier = Modifier.padding(horizontal = Caddie.dimens.gutter, vertical = 8.dp),
        )
        StateView(
            icon = LucideIcon.Star,
            body = Strings.Interested.EMPTY,
            action = StateAction(Strings.Interested.FIND_TALKS, { nav.selectTab(Tab.Search) }),
            hint = {
                CaddieButton(
                    Strings.Interested.IMPORT_HINT_PREFIX + Strings.Interested.IMPORT_HINT_LINK,
                    onClick = { nav.openSettings() },
                    variant = ButtonVariant.Text,
                    small = true,
                )
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
