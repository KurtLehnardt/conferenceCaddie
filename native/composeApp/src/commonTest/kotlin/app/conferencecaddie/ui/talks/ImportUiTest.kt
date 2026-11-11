package app.conferencecaddie.ui.talks

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.core.BundleState
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.ui.TestDevice
import app.conferencecaddie.ui.platform.IncomingHandoff
import app.conferencecaddie.ui.platform.PickedFile
import app.conferencecaddie.ui.platform.PlatformActions
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.strings.Strings
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.test.runTest
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory

// Import my schedule (web/src/components/import.tsx) on the device: from Settings, a pasted text, a
// file from the picker or one opened in the app, the review with its labels and ticks, marking with
// Undo, "View my schedule", the refusals, and the sheet's layouts. On the iOS simulator and an
// Android emulator.
@OptIn(ExperimentalTestApi::class)
class ImportUiTest {
    private val backend = TestBackend()
    private val root = Path(SystemTemporaryDirectory, "caddie-ui-import-${Random.nextLong().toULong()}")
    private val database = CaddieDatabase.open(":memory:")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val files = BundleFiles(Path(root, "bundles")).also { SystemFileSystem.createDirectories(Path(root, "bundles")) }
    private val core = CaddieCore(database, files, backend, scope, allowLocalHttp = false).also {
        it.setBackend(BackendUrl.normalise(backend.base) as BackendUrl.Valid)
    }
    private val alpha = backend.alpha.slug

    /** The text of a schedule with two exact titles and one close to a third. */
    private val schedule = "Intro to eBPF tracing\n\nKubernetes scheduling deep dive\n\nKubernetes networking basics today\n"

    /** A picker that returns [next]. */
    private class FakePicker(var next: PickedFile? = null) : PlatformActions {
        var asked = 0
        override fun pickScheduleFile(onPicked: (PickedFile?) -> Unit) {
            asked++
            onPicked(next)
        }
        override fun shareText(text: String, subject: String) = Unit
    }

    @BeforeTest
    fun nothingWaiting() = IncomingHandoff.clear()

    @AfterTest
    fun cleanUp() = runTest {
        IncomingHandoff.clear()
        scope.coroutineContext.job.cancelAndJoin()
        files.clear()
        SystemFileSystem.delete(Path(root, "bundles"), mustExist = false)
        SystemFileSystem.delete(root, mustExist = false)
        database.closeWhenIdle()
    }

    private fun ComposeUiTest.waitFor(tag: String? = null, text: String? = null): SemanticsNodeInteraction {
        val matcher = if (tag != null) hasTestTag(tag) else hasText(text!!)
        waitUntil(timeoutMillis = 20_000) { onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        return if (tag != null) onNodeWithTag(tag) else onNodeWithText(text!!)
    }

    /** The review's summary line as it reads. */
    private fun ComposeUiTest.summary(): String =
        waitFor(tag = "import-summary").fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.Text].joinToString("") { it.text }

    private fun ComposeUiTest.gone(tag: String) = waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isEmpty() }

    private fun ComposeUiTest.start(platform: PlatformActions = PlatformActions.None, size: DpSize? = null, fontScale: Float = 1f) {
        setContent {
            val app = @androidx.compose.runtime.Composable {
                CaddieApp(core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Search), platform = platform)
            }
            if (size != null) TestDevice(size, fontScale) { app() } else app()
        }
        waitUntil(timeoutMillis = 20_000) { (core.state.value.bundle as? BundleState.Ready)?.bundle?.conference?.slug == alpha }
    }

    private fun ComposeUiTest.openImport() {
        onNode(hasContentDescription(Strings.AppBar.SETTINGS)).performClick()
        waitFor(tag = "settings-import").performClick()
        waitFor(tag = "import-sheet")
    }

    @Test
    fun pastedTextFindsTheTalksAndMarksTheStrongOnes() = runComposeUiTest {
        start()
        openImport()
        waitFor(text = Strings.Import.lead("Alpha Conference"))
        waitFor(text = Strings.Import.FORMATS)
        onNodeWithTag("import-find").assertDoesNotExist()
        onNodeWithTag("import-paste-toggle").performClick()
        waitFor(tag = "import-find").assertIsNotEnabled()
        onNodeWithTag("import-paste").performTextReplacement(schedule)
        onNodeWithTag("import-find").assertIsEnabled().performClick()

        // Two exact titles ticked, the similar title left for the person to check.
        waitFor(tag = "import-review")
        assertEquals(Strings.Import.found(3, "Alpha Conference"), summary())
        waitFor(text = Strings.Import.HELP)
        onNodeWithTag("import-row-$alpha:1").assertIsOn()
        onNodeWithTag("import-row-$alpha:3").assertIsOn()
        onNodeWithTag("import-row-$alpha:4").assertIsOff()
        onNodeWithText(Strings.Import.TITLE_WORDS).assertIsDisplayed()
        onNodeWithText(Strings.Import.fromFile("Kubernetes networking basics today")).assertIsDisplayed()
        waitFor(text = Strings.Import.mark(2))
        onNodeWithTag("import-row-$alpha:4").performClick()
        waitFor(text = Strings.Import.mark(3)).performClick()

        // Marked on this device; the confirmation offers Undo and My schedule's Day view.
        waitFor(tag = "import-done")
        waitFor(text = Strings.Import.marked(3))
        waitUntil(timeoutMillis = 20_000) { core.state.value.interested.toSet() == setOf("$alpha:1", "$alpha:3", "$alpha:4") }
        onNodeWithTag("import-view").performClick()
        gone("import-sheet")
        waitFor(tag = "day-timeline")
        onNodeWithTag("tab-Interested").assertIsSelected()
        waitFor(tag = "timeline-$alpha:1")
    }

    @Test
    fun aChosenFileCanBeUndoneAndTalksAlreadyMarkedAreSaidSo() = runComposeUiTest {
        core.setInterested("$alpha:3", true)
        val csv = "Title,Speaker,Start\n\"Intro to eBPF tracing\",Ada Lovelace,2099-03-03 10:00\n\"Kubernetes scheduling deep dive\",Grace Hopper,2099-03-03 13:30\n"
        val picker = FakePicker(PickedFile("my-schedule.csv", "text/csv", csv.encodeToByteArray()))
        start(picker)
        openImport()
        onNodeWithTag("import-choose").performClick()
        waitFor(tag = "import-review")
        assertEquals(1, picker.asked)
        assertEquals(Strings.Import.found(2, "Alpha Conference"), summary())
        // The talk already marked is shown as such, ticked and not counted.
        onNodeWithTag("import-row-$alpha:3").assertIsOn().assertIsNotEnabled()
        onNodeWithText(Strings.Import.ALREADY).assertIsDisplayed()
        waitFor(text = Strings.Import.mark(1)).performClick()
        waitFor(tag = "import-done")
        waitUntil(timeoutMillis = 20_000) { core.state.value.interested.toSet() == setOf("$alpha:1", "$alpha:3") }
        onNodeWithTag("import-undo").performClick()
        waitFor(tag = "import-review")
        waitUntil(timeoutMillis = 20_000) { core.state.value.interested == listOf("$alpha:3") }

        // Start over goes back to the first page; Close leaves.
        onNodeWithTag("import-start-over").performClick()
        waitFor(tag = "import-choose")
        onNodeWithTag("import-close").performClick()
        gone("import-sheet")
    }

    @Test
    fun filesTheAppCannotReadAreRefusedWithAReason() = runComposeUiTest {
        val picker = FakePicker()
        start(picker)
        openImport()
        val cases = listOf(
            PickedFile("big.csv", "text/csv", null, tooLarge = true) to Strings.Import.TOO_LARGE,
            PickedFile("empty.txt", "text/plain", ByteArray(0)) to Strings.Import.EMPTY_FILE,
            PickedFile("gone.ics", "text/calendar", null) to Strings.Import.UNOPENABLE,
            PickedFile("schedule.pdf", "application/pdf", "%PDF-1.7\n1 0 obj".encodeToByteArray()) to Strings.Import.DOCUMENT,
            PickedFile("image.png", "image/png", byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0xff.toByte(), 0xfe.toByte(), 0, 0x80.toByte())) to Strings.Import.UNSUPPORTED,
            PickedFile("blank.txt", "text/plain", "﻿   \n\n".encodeToByteArray()) to Strings.Import.UNREADABLE,
        )
        for ((file, message) in cases) {
            picker.next = file
            onNodeWithTag("import-choose").performClick()
            waitFor(text = message)
            onNodeWithTag("import-error").assertIsDisplayed()
        }
        // Nothing was marked.
        assertTrue(core.state.value.interested.isEmpty())
    }

    @Test
    fun aScheduleForAnotherConferenceOffersTheSwitcher() = runComposeUiTest {
        start()
        openImport()
        onNodeWithTag("import-paste-toggle").performClick()
        onNodeWithTag("import-paste").performTextReplacement("Rust for embedded devices\n\nWriting drivers in safe Rust\n")
        onNodeWithTag("import-find").performClick()
        waitFor(tag = "import-review")
        assertEquals(Strings.Import.noneFound("Alpha Conference") + Strings.Import.unmatched(2), summary())
        waitFor(tag = "import-switch").performClick()
        gone("import-sheet")
        waitFor(text = "Beta Conference").performClick()
        waitUntil(timeoutMillis = 20_000) { core.state.value.selectedSlug == backend.beta.slug }
    }

    @Test
    fun aFileOpenedInTheAppOpensTheImport() = runComposeUiTest {
        start()
        IncomingHandoff.offerFile(PickedFile("Calendar.ics", "text/calendar", ics().encodeToByteArray()))
        waitFor(tag = "import-sheet")
        waitFor(tag = "import-review")
        assertEquals(Strings.Import.found(1, "Alpha Conference"), summary())
        // The start time in the file matches the talk's to the minute.
        onNodeWithText(Strings.Import.TITLE_AND_TIME).assertIsDisplayed()
        onNodeWithTag("import-row-$alpha:4").assertIsOn()
    }

    private fun ics() = listOf(
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "DTSTART:20990303T150000Z",
        "SUMMARY:Kubernetes networking basics again",
        "END:VEVENT",
        "END:VCALENDAR",
    ).joinToString("\r\n")

    @Test
    fun theSheetIsADialogInAWideWindow() = runComposeUiTest {
        start(size = DpSize(1024.dp, 768.dp))
        openImport()
        val sheet = onNodeWithTag("import-sheet").getUnclippedBoundsInRoot()
        assertTrue(sheet.right - sheet.left <= 561.dp, "the import dialog is wider than the web's 560 dp")
        onNodeWithTag("import-choose").assertIsDisplayed()
    }

    @Test
    fun aSmallPhoneAtTwiceTheFontSizeCanStillImport() = runComposeUiTest {
        start(size = DpSize(320.dp, 640.dp), fontScale = 2f)
        openImport()
        onNodeWithTag("import-paste-toggle").performScrollTo().performClick()
        onNodeWithTag("import-paste").performScrollTo().performTextReplacement(schedule)
        onNodeWithTag("import-find").performScrollTo().performClick()
        waitFor(tag = "import-review")
        // The footer's buttons stay on screen however long the review is.
        onNodeWithTag("import-mark").assertIsDisplayed().performClick()
        waitFor(tag = "import-done")
        onNodeWithTag("import-view").assertIsDisplayed()
    }
}
