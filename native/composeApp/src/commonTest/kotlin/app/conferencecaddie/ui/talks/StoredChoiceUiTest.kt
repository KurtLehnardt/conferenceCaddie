package app.conferencecaddie.ui.talks

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.core.BundleState
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.ThemePreference
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory

// The theme and My schedule's view are kept on the device and read once at start. A choice made
// before that read returns stays: the read never puts the older stored choice back. The test holds
// the read by keeping the database busy, so the choice is always made while the read waits.
@OptIn(ExperimentalTestApi::class)
class StoredChoiceUiTest {
    private val backend = TestBackend().also { it.publish(listOf(it.gamma, it.alpha, it.beta)) }
    private val root = Path(SystemTemporaryDirectory, "caddie-ui-choice-${Random.nextLong().toULong()}")
    private val database = CaddieDatabase.open(":memory:")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val files = BundleFiles(Path(root, "bundles")).also { SystemFileSystem.createDirectories(Path(root, "bundles")) }
    private val core = CaddieCore(database, files, backend, scope, allowLocalHttp = false).also {
        it.setBackend(BackendUrl.normalise(backend.base) as BackendUrl.Valid)
    }
    private val gamma = backend.gamma.slug
    private val released = CompletableDeferred<Unit>()

    @AfterTest
    fun cleanUp() = runTest {
        released.complete(Unit)
        scope.coroutineContext.job.cancelAndJoin()
        files.clear()
        SystemFileSystem.delete(Path(root, "bundles"), mustExist = false)
        SystemFileSystem.delete(root, mustExist = false)
        database.closeWhenIdle()
    }

    /** Keeps the database busy until [released], so every read and write of the core waits. */
    private fun holdTheDatabase() = runBlocking {
        val held = CompletableDeferred<Unit>()
        scope.launch { database.run { runBlocking { held.complete(Unit); released.await() } } }
        withTimeout(20_000) { held.await() }
    }

    private fun ComposeUiTest.option(text: String, under: String) = onNode(hasText(text) and isSelectable() and hasAnyAncestor(hasTestTag(under)))

    private fun ComposeUiTest.settingsOption(text: String) = onNode(hasText(text) and isSelectable())

    /** Waits until the stored [name] is [value]; that read comes after the app's own, so the app's has returned. */
    private fun ComposeUiTest.waitForStored(name: String, value: String) {
        waitUntil(timeoutMillis = 20_000) { runBlocking { core.uiSetting(name) } == value }
        waitForIdle()
    }

    @Test
    fun aThemeChosenWhileTheStoredOneIsReadStays() = runComposeUiTest {
        core.setUiSetting("theme", ThemePreference.Light.name)
        runBlocking { core.awaitIdle() }
        holdTheDatabase()
        setContent { CaddieApp(core, isDebugBuild = false, appVersion = "test") }
        // The app's read of the stored theme has started and waits for the database.
        waitForIdle()
        onNodeWithContentDescription(Strings.AppBar.SETTINGS).performClick()
        settingsOption(Strings.Settings.THEME_DARK).performClick()
        waitForIdle()
        settingsOption(Strings.Settings.THEME_DARK).assertIsSelected()

        released.complete(Unit)
        waitForStored("theme", ThemePreference.Dark.name)
        settingsOption(Strings.Settings.THEME_DARK).assertIsSelected()
        settingsOption(Strings.Settings.THEME_LIGHT).assertIsNotSelected()
    }

    @Test
    fun aViewChosenWhileTheStoredOneIsReadStays() = runComposeUiTest {
        runBlocking {
            withTimeout(20_000) { core.state.first { it.selectedSlug == gamma && it.bundle is BundleState.Ready } }
            core.setInterested("$gamma:1", true)
            core.setInterested("$gamma:2", true)
            core.setUiSetting("myschedule.view.v1", "day")
            core.awaitIdle()
        }
        holdTheDatabase()
        // The theme comes from the launch, so the first read the app makes is My schedule's view.
        setContent {
            CaddieApp(core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Interested, theme = ThemePreference.Light))
        }
        waitForIdle()
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag("my-schedule-view")).fetchSemanticsNodes().isNotEmpty() }
        option(Strings.Interested.VIEW_DAY, "my-schedule-view").performClick()
        option(Strings.Interested.VIEW_LIST, "my-schedule-view").performClick()
        waitForIdle()
        option(Strings.Interested.VIEW_LIST, "my-schedule-view").assertIsSelected()

        released.complete(Unit)
        waitForStored("myschedule.view.v1", "list")
        option(Strings.Interested.VIEW_LIST, "my-schedule-view").assertIsSelected()
        option(Strings.Interested.VIEW_DAY, "my-schedule-view").assertIsNotSelected()
    }
}
