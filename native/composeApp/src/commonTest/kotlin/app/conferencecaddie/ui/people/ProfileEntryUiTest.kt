package app.conferencecaddie.ui.people

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import app.conferencecaddie.shared.AppLink
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.people.PeopleAvailability
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleKeyValue
import app.conferencecaddie.ui.App
import app.conferencecaddie.ui.ShellRequest
import app.conferencecaddie.ui.TestDevice
import app.conferencecaddie.ui.shell.PeoplePage
import app.conferencecaddie.ui.shell.SampleData
import app.conferencecaddie.ui.shell.ShellNavigation
import app.conferencecaddie.ui.shell.ShellPage
import app.conferencecaddie.ui.shell.ShellState
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.shell.TabContent
import app.conferencecaddie.ui.shell.rememberShellNavigation
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.talks.Restoration
import app.conferencecaddie.ui.theme.CaddieTheme
import app.conferencecaddie.ui.theme.PlatformTouchTarget
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking

// Profile can be found at any time and keeps no edit it cannot save: the People tab's Profile
// button next to Requests, Profile's Back to wherever it was opened (after a re-creation too), the
// failed records' "Try again" on Profile, and an edit the controller could not keep. Run on the iOS
// simulator and on Android.
@OptIn(ExperimentalTestApi::class)
class ProfileEntryUiTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val talks = PeopleTalks(bundle = null, interested = emptyList(), nowMs = 0)

    @AfterTest
    fun cleanUp() {
        owner.viewModelStore.clear()
        scope.cancel()
    }

    /** People records that fail to read or to write on demand, as a locked Keychain or a full disk does. */
    private class FlakyKeyValue : PeopleKeyValue {
        private val inner = MemoryKeyValue()

        @kotlin.concurrent.Volatile
        var failReads = false

        @kotlin.concurrent.Volatile
        var failWrites = false

        override suspend fun get(key: String): String? = if (failReads) error("records unreadable") else inner.get(key)

        /** While set, a write that fails waits for it first, as a slow disk does. */
        @kotlin.concurrent.Volatile
        var slowFailure: CompletableDeferred<Unit>? = null

        override suspend fun set(key: String, value: String?) {
            if (failWrites) {
                slowFailure?.await()
                error("disk I/O error")
            }
            inner.set(key, value)
        }
    }

    /** People records whose first reads wait for [open], as records still being read do. */
    private class SlowKeyValue(private val inner: PeopleKeyValue) : PeopleKeyValue {
        val open = CompletableDeferred<Unit>()

        override suspend fun get(key: String): String? {
            open.await()
            return inner.get(key)
        }

        override suspend fun set(key: String, value: String?) = inner.set(key, value)
    }

    private fun controller(kv: PeopleKeyValue) =
        PeopleController(kv, emptyPeopleApi, PeopleServices(secureStore = InMemorySecureStore()), scope, allowLocalHttp = false)

    private val backToPeople = Strings.AppBar.backTo(Strings.Tabs.PEOPLE)

    private fun shellState(online: Boolean, conference: String) = ShellState(
        capabilities = Capabilities(people = Capabilities.People(enabled = true)),
        conferences = SampleData.CONFERENCES,
        selectedConferenceId = conference,
        serverBase = TEST_BASE,
        officialServerBase = TEST_BASE,
        online = online,
        appVersion = "test",
    )

    /** The activity's ViewModelStore, which a re-creation keeps (the people layer's PeopleRetained lives there). */
    private val owner = object : ViewModelStoreOwner {
        override val viewModelStore = ViewModelStore()
    }

    /** The toasts the shell was asked to show (the message and the action's label), on the UI thread. */
    private val toasts = ArrayList<Pair<String, String?>>()

    /** The people host of the composition that shows now. */
    private var host: PeopleHost? = null

    /**
     * The app's shell with the People layer on [controller], on a phone of [size] that is [online],
     * at [conference], with the shell's [request] (states, so a test can change them); [restoration]
     * draws it when a test re-creates it, under [owner] as the activity's store.
     */
    private fun ComposeUiTest.showApp(
        controller: PeopleController,
        restoration: Restoration? = null,
        size: DpSize = TEST_PHONE,
        online: State<Boolean> = mutableStateOf(true),
        conference: State<String> = mutableStateOf(SampleData.CONFERENCES.first().id),
        request: State<ShellRequest?> = mutableStateOf(null),
    ): () -> ShellNavigation {
        lateinit var nav: ShellNavigation
        val content: @Composable () -> Unit = {
            CompositionLocalProvider(LocalViewModelStoreOwner provides owner) {
                nav = rememberShellNavigation()
                // Called on the UI thread, as the shell's toast is.
                val showToast: (String, String?, (() -> Unit)?) -> Unit = { message, label, _ -> toasts += message to label }
                val ui = rememberPeopleUi(controller, nav, talks, online.value, true, null, showToast, {}, {}, request.value)!!
                host = ui.host
                val tabs = TabContent(people = ui.tab, appBarActions = ui.appBarActions, peoplePage = ui.page, settingsPeople = ui.settings)
                TestDevice(size) { App(ui.shellState(shellState(online.value, conference.value)), content = tabs, navigation = nav, request = request.value) }
            }
        }
        if (restoration != null) restoration.setContent(content) else setContent(content)
        return { nav }
    }

    private fun ComposeUiTest.waitForTag(tag: String) =
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty() }

    private fun ComposeUiTest.waitForText(text: String) =
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasText(text)).fetchSemanticsNodes().isNotEmpty() }

    /**
     * [node] takes touches over at least the platform's minimum (48 dp on Android, 44 pt on iOS): its
     * touch bounds, which minimumInteractiveComponentSize() widens around a 44 dp icon button drawn
     * at the web's size.
     */
    private fun assertTouchTarget(node: SemanticsNodeInteraction) {
        val semantics = node.fetchSemanticsNode()
        val bounds = semantics.touchBoundsInRoot
        // Compose's own bounds assertions allow half a dp for the rounding to whole pixels at the
        // test phone's density, which is the node's own (TestDevice lowers it on a small emulator),
        // not the window's.
        val min: Dp = PlatformTouchTarget - 0.5.dp
        with(semantics.layoutInfo.density) {
            assertTrue(bounds.height.toDp() >= min, "touch height ${bounds.height.toDp()} is under $min")
            assertTrue(bounds.width.toDp() >= min, "touch width ${bounds.width.toDp()} is under $min")
        }
    }

    /** A controller at the sample conference whose profile has a name, so "Create my profile" no longer shows. */
    private fun namedController(kv: PeopleKeyValue = MemoryKeyValue()): PeopleController = controller(kv).also { c ->
        runBlocking {
            c.updateContext(peopleContext())
            check(c.updateProfile { it.copy(displayName = "Jordan Rivera") } == null)
        }
    }

    @Test
    fun theProfileButtonShowsOnceAProfileExistsAndOpensTheEditor() = runComposeUiTest {
        val controller = controller(MemoryKeyValue())
        runBlocking { controller.updateContext(peopleContext()) }
        val nav = showApp(controller)
        waitForTag("people-create-profile")
        onNodeWithTag("profile-button").assertIsDisplayed()

        // Once the profile has a name, the prompt that used to be the only way in from People is
        // gone and the button stays: after Requests, named "Profile" as on the web, with a full
        // touch target.
        runBlocking { check(controller.updateProfile { it.copy(displayName = "Jordan Rivera") } == null) }
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag("people-create-profile")).fetchSemanticsNodes().isEmpty() }
        onNodeWithTag("requests-button").assertIsDisplayed()
        val button = onNodeWithTag("profile-button").assertIsDisplayed().assertContentDescriptionEquals(Strings.AppBar.PROFILE)
        assertTouchTarget(button)
        val requests = onNodeWithTag("requests-button").fetchSemanticsNode().boundsInRoot
        val profile = button.fetchSemanticsNode().boundsInRoot
        val gear = onNodeWithContentDescription(Strings.AppBar.SETTINGS).fetchSemanticsNode().boundsInRoot
        assertTrue(profile.left >= requests.right && gear.left >= profile.right, "Requests, Profile, then the gear")
        button.performClick()

        waitForTag("profile-name")
        onNode(hasTestTag("profile-name") and hasAnyAncestor(hasTestTag("page-profile"))).assert(hasText("Jordan Rivera"))
        runOnIdle { assertEquals(listOf<ShellPage>(PeoplePage.Profile), nav().pages) }

        // Its Back says People and leads there, not to Settings, and the tab bar marks People meanwhile.
        onNodeWithTag("tab-People").assertIsSelected()
        onNodeWithContentDescription(Strings.AppBar.BACK_TO_SETTINGS).assertDoesNotExist()
        assertTouchTarget(onNodeWithContentDescription(backToPeople).assertIsDisplayed())
        onNodeWithContentDescription(backToPeople).performClick()
        waitForTag("people-home")
        onNodeWithTag("page-profile").assertDoesNotExist()
        onNodeWithTag("settings-screen").assertDoesNotExist()
        onNodeWithTag("tab-People").assertIsSelected()
        runOnIdle { assertEquals(emptyList(), nav().pages) }
    }

    @Test
    fun onlyPeopleHasTheButton() = runComposeUiTest {
        showApp(namedController())
        waitForTag("people-home")
        onNodeWithTag("profile-button").assertIsDisplayed()
        for (tab in listOf(Strings.Tabs.FOR_YOU, Strings.Tabs.SEARCH, Strings.Tabs.INTERESTED)) {
            onNodeWithTag("tab-$tab").performClick()
            waitForTag("tab-body-${tabKey(tab)}")
            onNodeWithTag("profile-button").assertDoesNotExist()
            onNodeWithTag("requests-button").assertDoesNotExist()
        }
    }

    private fun tabKey(name: String) = when (name) {
        Strings.Tabs.FOR_YOU -> "ForYou"
        else -> name
    }

    @Test
    fun offlineInANarrowWindowRequestsStepsAsideAndProfileStays() = runComposeUiTest {
        // As on the web below 360 px: the Offline badge, Profile and the gear leave the conference
        // name room, and Requests, which offline opens only "needs a connection", steps aside.
        val online = mutableStateOf(false)
        showApp(namedController(), size = DpSize(320.dp, 640.dp), online = online)
        waitForTag("people-offline")
        onNodeWithTag("requests-button").assertDoesNotExist()
        onNodeWithTag("profile-button").assertIsDisplayed().performClick()
        waitForTag("profile-name")

        // Online again, it is back.
        onNodeWithContentDescription(backToPeople).performClick()
        online.value = true
        waitForTag("people-home")
        onNodeWithTag("requests-button").assertIsDisplayed()
        onNodeWithTag("profile-button").assertIsDisplayed()
    }

    @Test
    fun offlineAtThreeHundredSixtyDpBothButtonsStay() = runComposeUiTest {
        showApp(namedController(), size = DpSize(360.dp, 640.dp), online = mutableStateOf(false))
        waitForTag("people-offline")
        onNodeWithTag("requests-button").assertIsDisplayed()
        onNodeWithTag("profile-button").assertIsDisplayed()
    }

    /** Opens Profile over the tab screen named [tab], as its "Open profile" (a share control's, a toast's) does, and checks its Back says [tab] and returns there. */
    private fun ComposeUiTest.backReturnsTo(tab: String, nav: () -> ShellNavigation, restoration: Restoration? = null) {
        onNodeWithTag("tab-$tab").performClick()
        waitForTag("tab-body-${tabKey(tab)}")
        runOnIdle { nav().openPage(PeoplePage.Profile) }
        waitForTag("profile-name")
        restoration?.emulateSaveAndRestore()
        waitForTag("profile-name")
        onNodeWithTag("tab-$tab").assertIsSelected()
        onNodeWithContentDescription(Strings.AppBar.BACK_TO_SETTINGS).assertDoesNotExist()
        onNodeWithContentDescription(Strings.AppBar.backTo(tab)).performClick()
        waitForTag("tab-body-${tabKey(tab)}")
        onNodeWithTag("tab-$tab").assertIsSelected()
        runOnIdle { assertEquals(emptyList(), nav().pages) }
    }

    @Test
    fun profilesBackNamesTheTabItWasOpenedFromAfterARecreationToo() = runComposeUiTest {
        val controller = namedController()
        val restoration = Restoration(this)
        val nav = showApp(controller, restoration)
        waitForTag("people-home")

        // From People's button: "‹ People", after the activity is re-created too.
        onNodeWithTag("profile-button").performClick()
        waitForTag("profile-name")
        restoration.emulateSaveAndRestore()
        waitForTag("profile-name")
        onNodeWithContentDescription(Strings.AppBar.BACK_TO_SETTINGS).assertDoesNotExist()
        onNodeWithContentDescription(backToPeople).performClick()
        waitForTag("people-home")
        runOnIdle { assertEquals(emptyList(), nav().pages) }

        // From For you, Search and Interested: that tab's name, back there.
        backReturnsTo(Strings.Tabs.FOR_YOU, nav, restoration)
        backReturnsTo(Strings.Tabs.SEARCH, nav)
        // A tab picked and Profile opened in the same frame (a link to a tab, then "Open profile"):
        // Profile knows the tab picked, not the one drawn before.
        runOnIdle {
            nav().selectTab(Tab.Interested)
            nav().openPage(PeoplePage.Profile)
        }
        waitForTag("profile-name")
        onNodeWithContentDescription(Strings.AppBar.backTo(Strings.Tabs.INTERESTED)).performClick()
        waitForTag("tab-body-Interested")
        backReturnsTo(Strings.Tabs.INTERESTED, nav, restoration)

        // From Settings: "‹ Settings", back to the Settings underneath, after a re-creation too, and
        // no tab marked.
        onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
        onNodeWithText(Strings.Settings.PROFILE).performClick()
        waitForTag("profile-name")
        restoration.emulateSaveAndRestore()
        waitForTag("profile-name")
        onNodeWithTag("tab-Interested").assertIsNotSelected()
        onNodeWithContentDescription(Strings.AppBar.backTo(Strings.Tabs.INTERESTED)).assertDoesNotExist()
        onNodeWithContentDescription(Strings.AppBar.BACK_TO_SETTINGS).performClick()
        waitForTag("settings-screen")
        runOnIdle { assertEquals(listOf<ShellPage>(ShellPage.Settings), nav().pages) }

        // From another page (Requests): Settings, as on the web.
        onNodeWithContentDescription(Strings.AppBar.BACK).performClick()
        onNodeWithTag("tab-People").performClick()
        waitForTag("people-home")
        onNodeWithTag("requests-button").performClick()
        waitForTag("page-inbox")
        runOnIdle { nav().openPage(PeoplePage.Profile) }
        waitForTag("profile-name")
        onNodeWithContentDescription(backToPeople).assertDoesNotExist()
        onNodeWithContentDescription(Strings.AppBar.BACK_TO_SETTINGS).assertIsDisplayed()
    }

    @Test
    fun fromAZoneLinkBackSaysPeopleAndTurnsNothingOn() = runComposeUiTest {
        // caddie://e/{slug}#/here/{zone} opens People with the presence setup on that zone (the
        // web's #/here/{zone}). Profile from there says People, and coming back turns no presence on.
        val controller = namedController()
        val request = mutableStateOf<ShellRequest?>(null)
        val nav = showApp(controller, request = request)
        waitForTag("people-home")
        request.value = ShellRequest(1, tab = Tab.People, people = AppLink.PeopleRoute.Here("Hallway"))
        // The link's setup panel, on its zone, and the request taken.
        waitForTag("presence-setup")
        waitUntil(timeoutMillis = 20_000) {
            onAllNodes(hasText("Hallway") and hasAnyAncestor(hasTestTag("presence-zone")), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        waitUntil(timeoutMillis = 20_000) { host?.request == null }
        onNodeWithTag("profile-button").performClick()
        waitForTag("profile-name")
        onNodeWithTag("tab-People").assertIsSelected()
        onNodeWithContentDescription(backToPeople).performClick()
        waitForTag("people-home")
        runOnIdle { assertEquals(emptyList(), nav().pages) }
        // Nothing asks for the zone again, and presence stays off until "I'm around".
        runOnIdle { assertEquals(null, host?.request) }
        assertFalse(controller.state.value.presence.on, "Back to People turns no presence on")
    }

    @Test
    fun aProfileLinkOpensProfileWithItsBackToSettings() = runComposeUiTest {
        // caddie://e/{slug}#/profile (a link, a notification): as on the web after a deep link, Back
        // leads to Settings, whichever tab showed when the link came.
        val request = mutableStateOf<ShellRequest?>(null)
        val nav = showApp(namedController(), request = request)
        waitForTag("people-home")
        request.value = ShellRequest(1, tab = Tab.People, people = AppLink.PeopleRoute.Profile)
        waitForTag("profile-name")
        onNodeWithContentDescription(backToPeople).assertDoesNotExist()
        onNodeWithTag("tab-People").assertIsNotSelected()
        onNodeWithContentDescription(Strings.AppBar.BACK_TO_SETTINGS).performClick()
        waitForTag("settings-screen")
        runOnIdle { assertEquals(listOf(PeoplePage.Profile, ShellPage.Settings), nav().pages) }
    }

    @Test
    fun atAnotherConferenceProfilesBackLeadsToSettings() = runComposeUiTest {
        val conference = mutableStateOf(SampleData.CONFERENCES.first().id)
        val nav = showApp(namedController(), conference = conference)
        waitForTag("people-home")
        onNodeWithTag("profile-button").performClick()
        waitForTag("profile-name")
        onNodeWithContentDescription(backToPeople).assertIsDisplayed()

        // The People screen it was opened over showed the first conference; now it is another one's.
        conference.value = SampleData.CONFERENCES[1].id
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasContentDescription(Strings.AppBar.BACK_TO_SETTINGS)).fetchSemanticsNodes().isNotEmpty() }
        onNodeWithContentDescription(backToPeople).assertDoesNotExist()
        onNodeWithTag("tab-People").assertIsNotSelected()
        onNodeWithContentDescription(Strings.AppBar.BACK_TO_SETTINGS).performClick()
        waitForTag("settings-screen")
        runOnIdle { assertEquals(listOf(PeoplePage.Profile, ShellPage.Settings), nav().pages) }
    }

    @Test
    fun profileShowsTryAgainWhileTheRecordsCannotBeOpened() = runComposeUiTest {
        val kv = FlakyKeyValue().apply { failReads = true }
        val controller = controller(kv)
        runBlocking { controller.updateContext(peopleContext()) }
        showApp(controller)
        waitForTag("people-session-failed")

        // Profile, from People's button, is the same message with "Try again", not an editor.
        onNodeWithTag("profile-button").performClick()
        waitForTag("page-profile")
        onNode(hasTestTag("people-session-failed") and hasAnyAncestor(hasTestTag("page-profile"))).assertIsDisplayed()
        onNodeWithTag("profile-name").assertDoesNotExist()
        onNodeWithText(PeopleCommonStrings.SESSION_FAILED).assertIsDisplayed()

        // Settings' Profile row says so too, and opens the same.
        onNodeWithContentDescription(backToPeople).performClick()
        onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
        waitForTag("settings-you")
        onNode(hasText(PeopleCommonStrings.SESSION_FAILED) and hasAnyAncestor(hasTestTag("settings-you"))).assertIsDisplayed()
        onNodeWithText(Strings.Settings.SET_UP_PROFILE).assertDoesNotExist()
        onNodeWithText(Strings.Settings.PROFILE).performClick()
        waitForTag("page-profile")
        onNodeWithTag("profile-name").assertDoesNotExist()

        // Try again, once the records can be read, opens the editor.
        kv.failReads = false
        onNode(hasTestTag("people-session-retry") and hasAnyAncestor(hasTestTag("page-profile"))).performClick()
        waitForTag("profile-name")
        onNodeWithTag("people-session-failed").assertDoesNotExist()
    }

    @Test
    fun anEditTheRecordsCannotTakeSaysSoAndStaysInItsField() = runComposeUiTest {
        val kv = FlakyKeyValue()
        val controller = namedController(kv)
        showApp(controller)
        waitForTag("people-home")
        onNodeWithTag("profile-button").performClick()
        waitForTag("profile-name")

        kv.failWrites = true
        onNodeWithTag("profile-about-me").performScrollTo().typeText("+1 555 0100")
        waitForText(PeopleCommonStrings.NOT_SAVED)
        onNodeWithTag("profile-save-status").assert(hasText(PeopleCommonStrings.NOT_SAVED))
        onNodeWithTag("profile-about-me").assert(hasText("+1 555 0100"))
        // Nothing holds it but the field: the controller, which a later write or the server's copy
        // reads, still has the profile as it was.
        assertEquals("", controller.state.value.profile.about)

        // Taken out again before anything was saved: the field and the controller agree once more,
        // and nothing brings it back once the records take writes.
        onNodeWithTag("profile-about-me").performScrollTo().typeText("")
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasText(PeopleCommonStrings.NOT_SAVED)).fetchSemanticsNodes().isEmpty() }
        kv.failWrites = false
        onNodeWithTag("profile-name").performScrollTo().typeText("Jordan Rivera B")
        waitUntil(timeoutMillis = 20_000) { controller.state.value.profile.displayName == "Jordan Rivera B" }
        assertEquals("", controller.state.value.profile.about)

        // An edit that fails, then the next one once the records take it: both are saved and the
        // message goes.
        kv.failWrites = true
        onNodeWithTag("profile-about-me").performScrollTo().typeText("Platform engineer.")
        waitForText(PeopleCommonStrings.NOT_SAVED)
        kv.failWrites = false
        onNodeWithTag("profile-about-me").performScrollTo().typeText("Platform engineer, SRE.")
        waitUntil(timeoutMillis = 20_000) { controller.state.value.profile.about == "Platform engineer, SRE." }
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasText(PeopleCommonStrings.NOT_SAVED)).fetchSemanticsNodes().isEmpty() }
        assertEquals("Jordan Rivera B", controller.state.value.profile.displayName)
    }

    @Test
    fun anEditThatWasNotSavedOutlivesARecreationAndLeavingSaysSoOnce() = runComposeUiTest {
        val kv = FlakyKeyValue()
        val controller = namedController(kv)
        val restoration = Restoration(this)
        val nav = showApp(controller, restoration)
        waitForTag("people-home")
        onNodeWithTag("profile-button").performClick()
        waitForTag("profile-name")

        // Not saved: after the activity is re-created the text is still in its field, with the message.
        kv.failWrites = true
        onNodeWithTag("profile-about-me").performScrollTo().typeText("Platform engineer.")
        waitForText(PeopleCommonStrings.NOT_SAVED)
        restoration.emulateSaveAndRestore()
        waitForTag("profile-name")
        onNodeWithTag("profile-about-me").assert(hasText("Platform engineer."))
        onNodeWithTag("profile-save-status").assert(hasText(PeopleCommonStrings.NOT_SAVED))

        // Two edits whose answers come after Profile was left: one toast says they were not saved,
        // with "Open profile".
        val slow = CompletableDeferred<Unit>()
        kv.slowFailure = slow
        onNodeWithTag("profile-about-me").performScrollTo().typeText("Platform engineer, SRE.")
        onNodeWithTag("profile-about-me").performScrollTo().typeText("Platform engineer, SRE, on call.")
        onNodeWithContentDescription(backToPeople).performClick()
        waitForTag("people-home")
        runOnIdle { assertEquals(emptyList(), toasts.toList()) }
        slow.complete(Unit)
        waitUntil(timeoutMillis = 20_000) { runOnIdle { toasts.isNotEmpty() } }
        // Both answers are in once the editor takes another push (its pushes run one at a time):
        // the second one says nothing more.
        val editor = runOnIdle { checkNotNull(host).profileEditor(controller.state.value.backend) { error("Profile's editor is gone") } }
        // Not runBlocking: on iOS the test runs on the main thread, where the earlier pushes resume.
        val barrier = scope.async { editor.push() }
        waitUntil(timeoutMillis = 20_000) { barrier.isCompleted }
        waitForIdle()
        runOnIdle { assertEquals(listOf(PeopleCommonStrings.NOT_SAVED to PeopleCommonStrings.OPEN_PROFILE), toasts.toList()) }

        // Opened again once the records take writes, the text is still there and is saved without
        // another keystroke.
        kv.failWrites = false
        onNodeWithTag("profile-button").performClick()
        waitForTag("profile-name")
        onNodeWithTag("profile-about-me").assert(hasText("Platform engineer, SRE, on call."))
        waitUntil(timeoutMillis = 20_000) { controller.state.value.profile.about == "Platform engineer, SRE, on call." }
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasText(PeopleCommonStrings.NOT_SAVED)).fetchSemanticsNodes().isEmpty() }
        runOnIdle { assertEquals(1, toasts.size) }
        runOnIdle { assertEquals(listOf<ShellPage>(PeoplePage.Profile), nav().pages) }
    }

    @Test
    fun profileShowsNothingToEditUntilTheRecordsAreRead() = runComposeUiTest {
        // A name stored by an earlier run.
        val records = MemoryKeyValue()
        controller(records).also { c ->
            runBlocking {
                c.updateContext(peopleContext())
                check(c.updateProfile { it.copy(displayName = "Jordan Rivera") } == null)
            }
            c.close()
        }
        // This run's records are still being read when Profile shows (after the process was ended,
        // say): no field to type over the empty profile with.
        val kv = SlowKeyValue(records)
        val controller = controller(kv)
        scope.launch { controller.updateContext(peopleContext()) }
        val nav = showApp(controller)
        runOnIdle { nav().openPage(PeoplePage.Profile) }
        waitForTag("profile-loading")
        onNodeWithTag("profile-name").assertDoesNotExist()

        kv.open.complete(Unit)
        waitForTag("profile-name")
        onNodeWithTag("profile-name").assert(hasText("Jordan Rivera"))
        onNodeWithTag("profile-loading").assertDoesNotExist()
    }

    @Test
    fun anEditThatArrivesWhileTheRecordsAreNotOpenSaysSoInsteadOfVanishing() = runComposeUiTest {
        // The screen still shows the profile it drew while the records were open; the records then
        // could not be opened again (another backend, a locked Keychain), so the controller has no
        // session when the edit arrives.
        val kv = FlakyKeyValue().apply { failReads = true }
        val controller = controller(kv)
        runBlocking { controller.updateContext(peopleContext()) }
        waitUntil(timeoutMillis = 20_000) { controller.state.value.sessionFailed }
        val host = PeopleHost(controller, ShellNavigation(), scope, { _, _ -> }, {}, {})
        setContent {
            TestPhone { CaddieTheme { ProfileScreen(readyState(), host, talks) } }
        }
        waitForTag("profile-name")

        onNodeWithTag("profile-name").performScrollTo().typeText("Jordan Rivera")
        waitForText(PeopleCommonStrings.NOT_SAVED)
        onNodeWithTag("profile-name").assert(hasText("Jordan Rivera"))
        assertEquals("", controller.state.value.profile.displayName)

        // Once the records open, the next edit takes what the field holds.
        kv.failReads = false
        onNodeWithTag("profile-name").performScrollTo().typeText("Jordan Rivera B")
        waitUntil(timeoutMillis = 20_000) { controller.state.value.profile.displayName == "Jordan Rivera B" }
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasText(PeopleCommonStrings.NOT_SAVED)).fetchSemanticsNodes().isEmpty() }
        assertEquals(PeopleAvailability.Ready, controller.state.value.availability)
    }
}
