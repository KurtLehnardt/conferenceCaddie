package app.conferencecaddie.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.SampleData
import app.conferencecaddie.ui.shell.ShellActions
import app.conferencecaddie.ui.shell.ShellState
import app.conferencecaddie.ui.shell.StandaloneShell
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.shell.pendingAfterSwitch
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.ThemePreference
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

// The shell's flows, run on the iOS simulator (iosSimulatorArm64Test) and on an Android device or
// emulator (connectedAndroidDeviceTest).
@OptIn(ExperimentalTestApi::class)
class ShellUiTest {
    private val official = "https://conference-caddie.example.org"

    private fun state(peopleEnabled: Boolean = false, selected: String? = SampleData.CONFERENCES.first().id) = ShellState(
        capabilities = Capabilities(people = Capabilities.People(enabled = peopleEnabled)),
        conferences = SampleData.CONFERENCES,
        selectedConferenceId = selected,
        serverBase = official,
        officialServerBase = official,
        appVersion = "test",
    )

    @Test
    fun tabsFollowTheWebOrderAndSwitch() = runComposeUiTest {
        setContent { App(state()) }

        // Without people features there is no People tab, and the app opens on For you.
        onNodeWithTag("tab-People").assertDoesNotExist()
        onNodeWithTag("tab-For you").assertIsSelected()
        onNodeWithTag("tab-body-ForYou").assertExists()

        onNodeWithTag("tab-Search").performClick()
        onNodeWithTag("tab-Search").assertIsSelected()
        onNodeWithTag("tab-body-Search").assertExists()

        onNodeWithTag("tab-Interested").performClick()
        onNodeWithText(Strings.Interested.EMPTY).assertIsDisplayed()
        // "Find talks" on the empty list goes to Search, as on the web.
        onNodeWithText(Strings.Interested.FIND_TALKS).performClick()
        onNodeWithTag("tab-Search").assertIsSelected()
    }

    @Test
    fun peopleTabAppearsOnlyWithPeopleFeatures() = runComposeUiTest {
        var current by mutableStateOf(state(peopleEnabled = true))
        setContent { App(current) }

        onNodeWithTag("tab-People").assertIsSelected()
        onNodeWithTag("tab-body-People").assertExists()

        // The backend turns people features off while People is showing: the tab goes and the
        // shell falls back to the first remaining tab.
        current = state(peopleEnabled = false)
        waitForIdle()
        onNodeWithTag("tab-People").assertDoesNotExist()
        onNodeWithTag("tab-For you").assertIsSelected()
    }

    @Test
    fun conferenceSwitcherPicksAConference() = runComposeUiTest {
        var picked: String? = null
        setContent { App(state(), ShellActions(onSelectConference = { picked = it })) }

        onNodeWithTag("conference-switcher").performClick()
        onNodeWithText(Strings.Switcher.TITLE).assertIsDisplayed()
        onNodeWithText(Strings.Switcher.UNAVAILABLE_HEADING.uppercase()).assertExists()
        onNodeWithText("Sample Dev Day Nairobi").performClick()
        waitForIdle()
        assertEquals("sample-dev-day-nairobi-2026", picked)
    }

    @Test
    fun anUnavailableConferenceShowsTheWebBlocker() = runComposeUiTest {
        setContent { App(state(selected = "sample-open-source-forum-2026")) }
        onNodeWithText(Strings.Blockers.SCHEDULE_NOT_AVAILABLE).assertIsDisplayed()
        onNodeWithText(Strings.Blockers.cantBeSearched("Sample Open Source Forum")).assertExists()
        onNodeWithText(Strings.Blockers.OPEN_OFFICIAL).assertExists()
    }

    @Test
    fun settingsValidatesTheServerAndConfirmsBeforeSwitching() = runComposeUiTest {
        var changed: String? = null
        setContent { App(state(), ShellActions(onChangeServer = { changed = it })) }

        onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
        onNodeWithTag("settings-screen").assertExists()

        // Refused addresses explain themselves and ask nothing.
        typeServer("not a url")
        saveServer()
        onNodeWithText(Strings.Settings.URL_NOT_A_URL).assertExists()
        typeServer("http://caddie.example.net")
        saveServer()
        onNodeWithText(Strings.Settings.URL_HTTPS).assertExists()
        onNodeWithTag("connect-confirmation").assertDoesNotExist()

        // A good address is normalised and named exactly in the confirmation; Cancel changes nothing.
        typeServer("https://Caddie.Example.net:443/demo/")
        saveServer()
        onNodeWithTag("connect-prompt").assertExists()
        onNodeWithText(Strings.Connect.prompt("https://caddie.example.net/demo")).assertIsDisplayed()
        onNodeWithText(Strings.Connect.NOT_OFFICIAL).assertExists()
        onNodeWithText(Strings.Common.CANCEL).performClick()
        onNodeWithTag("connect-confirmation").assertDoesNotExist()
        assertNull(changed)

        // Saving again and confirming switches.
        saveServer()
        onNodeWithText(Strings.Connect.SWITCH).performClick()
        waitForIdle()
        assertEquals("https://caddie.example.net/demo", changed)

        // Back leaves Settings.
        onNodeWithContentDescription(Strings.AppBar.BACK).performClick()
        onNodeWithTag("settings-screen").assertDoesNotExist()
    }

    @Test
    fun aConnectLinkNeedsConfirmationAndCanBeDeclined() = runComposeUiTest {
        var declined = false
        var changed: String? = null
        var current by mutableStateOf(state().copy(pendingConnect = "https://kurtlehnardt.github.io/conferenceCaddie"))
        setContent {
            App(
                current,
                ShellActions(
                    onChangeServer = { changed = it },
                    onDeclineConnect = {
                        declined = true
                        current = current.copy(pendingConnect = null)
                    },
                ),
            )
        }

        onNodeWithText(Strings.Connect.prompt("https://kurtlehnardt.github.io/conferenceCaddie")).assertIsDisplayed()
        onNodeWithText(Strings.Common.CANCEL).performClick()
        waitForIdle()
        assertEquals(true, declined)
        assertNull(changed)
        onNodeWithTag("connect-confirmation").assertDoesNotExist()
    }

    @Test
    fun anOfficialServerLinkHasNoWarningAndSwitchesOnConfirm() = runComposeUiTest {
        var changed: String? = null
        setContent { App(state().copy(pendingConnect = official), ShellActions(onChangeServer = { changed = it })) }

        onNodeWithText(Strings.Connect.prompt(official)).assertIsDisplayed()
        onNodeWithText(Strings.Connect.NOT_OFFICIAL).assertDoesNotExist()
        onNodeWithText(Strings.Connect.SWITCH).performClick()
        waitForIdle()
        assertEquals(official, changed)
    }

    @Test
    fun aLinkWaitsWhileATypedServerIsBeingConfirmed() = runComposeUiTest {
        val link = "https://kurtlehnardt.github.io/conferenceCaddie"
        var declined = false
        var current by mutableStateOf(state())
        setContent {
            App(
                current,
                ShellActions(
                    onDeclineConnect = {
                        declined = true
                        current = current.copy(pendingConnect = null)
                    },
                ),
            )
        }

        onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
        typeServer("https://caddie.example.net")
        saveServer()
        onNodeWithText(Strings.Connect.prompt("https://caddie.example.net")).assertIsDisplayed()

        // A link arrives while the typed server's question is open: the question stays as it is.
        current = current.copy(pendingConnect = link)
        waitForIdle()
        onNodeWithText(Strings.Connect.prompt("https://caddie.example.net")).assertIsDisplayed()
        onNodeWithText(Strings.Connect.prompt(link)).assertDoesNotExist()

        // Cancelling the typed server leaves the link alone; its question comes next.
        onNodeWithText(Strings.Common.CANCEL).performClick()
        waitForIdle()
        assertFalse(declined)
        onNodeWithText(Strings.Connect.prompt(link)).assertIsDisplayed()
        onNodeWithText(Strings.Common.CANCEL).performClick()
        waitForIdle()
        assertTrue(declined)
        onNodeWithTag("connect-confirmation").assertDoesNotExist()
    }

    @Test
    fun confirmingATypedServerKeepsAWaitingLinkForTheNextQuestion() = runComposeUiTest {
        val link = "https://kurtlehnardt.github.io/conferenceCaddie"
        val changed = mutableListOf<String>()
        var current by mutableStateOf(state())
        setContent {
            App(
                current,
                ShellActions(
                    // As ShellActions.onChangeServer asks: clear the link only when it was the one answered.
                    onChangeServer = {
                        changed += it
                        current = current.copy(serverBase = it, pendingConnect = pendingAfterSwitch(current.pendingConnect, it))
                    },
                ),
            )
        }

        onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
        typeServer("https://caddie.example.net")
        saveServer()
        current = current.copy(pendingConnect = link)
        waitForIdle()

        // Switching to the typed server answers that question only; the link is asked next.
        onNodeWithText(Strings.Connect.SWITCH).performClick()
        waitForIdle()
        assertEquals(listOf("https://caddie.example.net"), changed)
        onNodeWithText(Strings.Connect.prompt(link)).assertIsDisplayed()
        onNodeWithText(Strings.Connect.SWITCH).performClick()
        waitForIdle()
        assertEquals(listOf("https://caddie.example.net", link), changed)
        onNodeWithTag("connect-confirmation").assertDoesNotExist()
    }

    @Test
    fun theThemeSettingReportsTheChoice() = runComposeUiTest {
        var chosen: ThemePreference? = null
        setContent { App(state(), ShellActions(onThemeChange = { chosen = it })) }

        onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
        onNode(hasText(Strings.Settings.THEME_SYSTEM) and isSelectable()).assertIsSelected()
        onNode(hasText(Strings.Settings.THEME_DARK) and isSelectable()).assertIsNotSelected().performClick()
        waitForIdle()
        assertEquals(ThemePreference.Dark, chosen)
    }

    @Test
    fun theSystemBackLeavesSettings() = runComposeUiTest {
        val back = SystemBack()
        setContent { back.Provide { App(state()) } }

        onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
        onNodeWithTag("settings-screen").assertExists()
        runOnUiThread { back.press() }
        waitForIdle()
        onNodeWithTag("settings-screen").assertDoesNotExist()
        onNodeWithTag("tab-For you").assertIsSelected()
    }

    @Test
    fun releaseBuildsIgnoreTheDebugLaunchOptions() = runComposeUiTest {
        setContent {
            StandaloneShell(
                isDebugBuild = false,
                launch = DebugLaunch(
                    tab = Tab.Search,
                    open = "settings",
                    theme = ThemePreference.Dark,
                    connect = "https://caddie.example.net",
                    gallery = true,
                ),
            )
        }
        waitForIdle()

        onNodeWithTag("connect-confirmation").assertDoesNotExist()
        onNodeWithTag("settings-screen").assertDoesNotExist()
        onNodeWithTag("tab-For you").assertIsSelected()
        // No sample conferences either: a release build has no conference until a backend gives one.
        onNodeWithText(Strings.Blockers.NO_CONFERENCES).assertIsDisplayed()
        // The theme stays on the System choice.
        onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
        onNode(hasText(Strings.Settings.THEME_SYSTEM) and isSelectable()).assertIsSelected()
    }

    @Test
    fun debugBuildsOnlyAskAboutAServerALinkCouldName() = runComposeUiTest {
        var connect by mutableStateOf("HTTPS://Caddie.Example.ORG/demo/")
        setContent { StandaloneShell(isDebugBuild = true, launch = DebugLaunch(open = "settings", connect = connect)) }

        // Normalised as a link would be, and Settings opened as asked.
        onNodeWithText(Strings.Connect.prompt("https://caddie.example.org/demo")).assertIsDisplayed()
        onNodeWithText(Strings.Common.CANCEL).performClick()
        waitForIdle()
        onNodeWithTag("settings-screen").assertExists()
    }

    @Test
    fun debugBuildsRefuseALaunchServerALinkCouldNotName() = runComposeUiTest {
        setContent { StandaloneShell(isDebugBuild = true, launch = DebugLaunch(connect = "http://localhost:8080")) }
        waitForIdle()
        // Plain http to a local server is allowed only when typed in Settings, never from a link.
        onNodeWithTag("connect-confirmation").assertDoesNotExist()
    }

    @Test
    fun theShellFitsA320DpPhoneAtTwiceTheFontSize() = runComposeUiTest {
        setContent {
            TestDevice(DpSize(320.dp, 640.dp), fontScale = 2f) {
                App(state(peopleEnabled = true))
            }
        }

        onNodeWithTag("nav-rail").assertDoesNotExist()
        for (label in listOf(Strings.Tabs.PEOPLE, Strings.Tabs.FOR_YOU, Strings.Tabs.SEARCH, Strings.Tabs.INTERESTED)) {
            onNodeWithTag("tab-$label").assertIsDisplayed()
            // Each label keeps to one line inside its quarter of the bar, neither wrapped nor cut off.
            val layouts = mutableListOf<TextLayoutResult>()
            onNodeWithText(label, useUnmergedTree = true).fetchSemanticsNode()
                .config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
            val layout = layouts.single()
            assertEquals(1, layout.lineCount, label)
            assertFalse(layout.didOverflowWidth, "$label is wider than its tab")
            assertFalse(layout.isLineEllipsized(0), "$label is cut off")
        }
        onNodeWithTag("conference-switcher").assertIsDisplayed()
        onNodeWithContentDescription(Strings.AppBar.SETTINGS).assertIsDisplayed()

        onNodeWithTag("tab-Interested").performClick()
        onNodeWithText(Strings.Interested.FIND_TALKS).performScrollTo().assertIsDisplayed()

        onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
        onNodeWithTag("server-save").performScrollTo().assertIsDisplayed()
        onNodeWithContentDescription(Strings.AppBar.BACK).assertIsDisplayed().performClick()
        onNodeWithTag("settings-screen").assertDoesNotExist()
    }

    @Test
    fun aWideWindowGetsTheRailAndACentredColumn() = runComposeUiTest {
        setContent {
            TestDevice(DpSize(1024.dp, 768.dp)) {
                App(state(peopleEnabled = true))
            }
        }

        // The web's layout from 768 px: the tabs on a rail at the left, in the same order.
        onNodeWithTag("nav-rail").assertIsDisplayed()
        // The window is scaled down to fit the test device's screen, so a pixel can be several dp.
        val slack = (3f / onNodeWithTag("nav-rail").fetchSemanticsNode().layoutInfo.density.density).dp
        val rail = onNodeWithTag("nav-rail").getUnclippedBoundsInRoot()
        assertAbout(88.dp, rail.right - rail.left, slack)
        val people = onNodeWithTag("tab-People").getUnclippedBoundsInRoot()
        val interested = onNodeWithTag("tab-Interested").getUnclippedBoundsInRoot()
        assertTrue(people.top < interested.top, "the rail's tabs are not stacked in order")

        // The content stays within 720 dp, centred in the space right of the rail.
        onNodeWithTag("tab-Search").performClick()
        val body = onNodeWithTag("tab-body-Search").getUnclippedBoundsInRoot()
        assertAbout(720.dp, body.right - body.left, slack)
        assertAbout((1024.dp - 88.dp - 720.dp) / 2, body.left - rail.right, slack)

        onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
        onNodeWithTag("settings-screen").assertIsDisplayed()
        onNodeWithTag("tab-Search").assertIsNotSelected()
    }

    @Test
    fun theRailShowsEveryTabOnAShortWindowAndScrollsOnAShorterOne() = runComposeUiTest {
        var height by mutableStateOf(360.dp)
        setContent { TestDevice(DpSize(780.dp, height)) { App(state(peopleEnabled = true)) } }
        val labels = listOf(Strings.Tabs.PEOPLE, Strings.Tabs.FOR_YOU, Strings.Tabs.SEARCH, Strings.Tabs.INTERESTED)

        onNodeWithTag("nav-rail").assertIsDisplayed()
        for (label in labels) onNodeWithTag("tab-$label").assertIsDisplayed()

        // Shorter than the icon and four tabs: the rail scrolls, and every tab can still be reached.
        height = 260.dp
        waitForIdle()
        for (label in labels) onNodeWithTag("tab-$label").performScrollTo().assertIsDisplayed()
        onNodeWithTag("tab-${Strings.Tabs.INTERESTED}").performClick()
        onNodeWithTag("tab-${Strings.Tabs.INTERESTED}").assertIsSelected()
    }

    @Test
    fun aPhoneInLandscapeKeepsEveryControlReachable() = runComposeUiTest {
        // A phone turned sideways is wider than 768 dp, so it gets the wide layout, as on the web.
        setContent {
            TestDevice(DpSize(844.dp, 390.dp)) {
                App(state())
            }
        }

        onNodeWithTag("nav-rail").assertIsDisplayed()
        onNodeWithTag("tab-Interested").assertIsDisplayed().performClick()
        onNodeWithContentDescription(Strings.AppBar.SETTINGS).assertIsDisplayed().performClick()
        onNodeWithTag("server-save").performScrollTo().assertIsDisplayed()
        onNodeWithContentDescription(Strings.AppBar.BACK).assertIsDisplayed()
    }

    // Sizes measured in a scaled-down window go through whole pixels, so allow [slack] either way.
    private fun assertAbout(expected: Dp, actual: Dp, slack: Dp) =
        assertTrue(actual in (expected - slack)..(expected + slack), "expected about $expected, got $actual")

    // Puts [text] in the Server URL field as typing would, without focusing it: a focused field
    // brings up the software keyboard on an emulator, which covers the screen of a small device
    // while it animates and makes the test depend on the keyboard. The keyboard itself is checked on
    // devices (see the pull request's screenshots).
    private fun ComposeUiTest.typeServer(text: String) =
        onNodeWithTag("server-url").performSemanticsAction(SemanticsActions.SetText) { it(AnnotatedString(text)) }

    private fun ComposeUiTest.saveServer() = onNodeWithTag("server-save").performScrollTo().performClick()
}
