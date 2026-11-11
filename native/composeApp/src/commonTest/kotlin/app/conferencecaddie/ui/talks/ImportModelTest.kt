package app.conferencecaddie.ui.talks

import app.conferencecaddie.shared.importer.ImportInput
import app.conferencecaddie.shared.importer.ImportOutcome
import app.conferencecaddie.shared.importer.ImportRefusal
import app.conferencecaddie.shared.importer.ImportResult
import app.conferencecaddie.ui.platform.PickedFile
import app.conferencecaddie.ui.strings.Strings
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

// ImportModel's state across imports that overlap (a file chosen while an earlier one is still being
// read), Cancel, and an import whose scope ends (a rotation). On the iOS simulator and an Android emulator.
class ImportModelTest {
    private val empty = ImportResult(emptyList(), unmatchedCount = 3, extractedChars = 10)

    /** Imports that finish only when the test completes their answer, in the order they started. */
    private class Pending {
        val answers = ArrayList<CompletableDeferred<ImportOutcome>>()
        suspend fun run(@Suppress("UNUSED_PARAMETER") input: ImportInput): ImportOutcome =
            CompletableDeferred<ImportOutcome>().also { answers += it }.await()
    }

    private fun TestScope.model(pending: Pending) = ImportModel(this) { pending.run(it) }

    @Test
    fun aCancelledImportDoesNotStopTheSpinnerOfTheNextOne() = runTest(StandardTestDispatcher()) {
        val pending = Pending()
        val m = model(pending)
        m.pasteText = "first"
        m.runText(emptySet())
        advanceUntilIdle()
        m.runFile(PickedFile("second.csv", "text/csv", "Title\nSomething".encodeToByteArray()), emptySet())
        advanceUntilIdle()
        // The first import's cleanup has run; the second is still reading.
        assertEquals(2, pending.answers.size)
        assertTrue(m.busy, "the spinner stopped while the second import was still running")
        // The first one's late answer changes nothing.
        pending.answers[0].complete(ImportOutcome.Refused(ImportRefusal.Unreadable))
        advanceUntilIdle()
        assertTrue(m.busy)
        assertNull(m.error)
        pending.answers[1].complete(ImportOutcome.Done(empty, onServer = false))
        advanceUntilIdle()
        assertFalse(m.busy)
        assertEquals(empty, m.result)
    }

    @Test
    fun cancelStopsReadingAndKeepsTheFirstPage() = runTest(StandardTestDispatcher()) {
        val pending = Pending()
        val m = model(pending)
        m.pasteText = "text"
        m.runText(emptySet())
        advanceUntilIdle()
        assertTrue(m.busy)
        m.cancel()
        assertFalse(m.busy)
        pending.answers[0].complete(ImportOutcome.Done(empty, onServer = false))
        advanceUntilIdle()
        assertNull(m.result)
        assertFalse(m.busy)
    }

    @Test
    fun anImportCutShortByItsScopeRunsAgainInTheNextOne() = runTest(StandardTestDispatcher()) {
        // A rotation on Android ends the composition's scope while the model lives on.
        val pending = Pending()
        val first = CoroutineScope(coroutineContext + Job(coroutineContext[Job]))
        val m = ImportModel(first) { pending.run(it) }
        m.pasteText = "text"
        m.runText(setOf("a:1"))
        advanceUntilIdle()
        first.cancel()
        advanceUntilIdle()
        assertTrue(m.busy, "the import was dropped with its scope")
        val second = CoroutineScope(coroutineContext + Job(coroutineContext[Job]))
        m.attach(second)
        advanceUntilIdle()
        assertEquals(2, pending.answers.size, "the import did not run again")
        pending.answers[1].complete(ImportOutcome.Done(empty, onServer = false))
        advanceUntilIdle()
        assertFalse(m.busy)
        assertEquals(empty, m.result)
        // Nothing is left to run again.
        val third = CoroutineScope(coroutineContext + Job(coroutineContext[Job]))
        m.attach(third)
        advanceUntilIdle()
        assertEquals(2, pending.answers.size)
        second.cancel()
        third.cancel()
    }

    @Test
    fun aFileFromAnotherAppWaitsForATap() = runTest(StandardTestDispatcher()) {
        val pending = Pending()
        val m = model(pending)
        m.offer(PickedFile("shared.ics", "text/calendar", "BEGIN:VCALENDAR".encodeToByteArray()))
        advanceUntilIdle()
        assertTrue(pending.answers.isEmpty(), "a shared file was read before the person asked")
        assertFalse(m.busy)
        m.runOffered(emptySet())
        advanceUntilIdle()
        assertEquals(1, pending.answers.size)
        assertNull(m.offered)
        pending.answers[0].complete(ImportOutcome.Done(empty, onServer = false))
        advanceUntilIdle()
        // Closing and opening again forgets it.
        m.offer(PickedFile("again.csv", "text/csv", "Title".encodeToByteArray()))
        m.reset()
        assertNull(m.offered)
    }

    @Test
    fun anErrorDuringAnImportIsShownNotThrown() = runTest(StandardTestDispatcher()) {
        // An allocation that fails while a hostile file is read is an Error, not an Exception.
        val m = ImportModel(this) { throw Error("an allocation failed") }
        m.pasteText = "text"
        m.runText(emptySet())
        advanceUntilIdle()
        assertEquals(Strings.Import.UNAVAILABLE, m.error)
        assertFalse(m.busy)
    }

    @Test
    fun filesTheDeviceCouldNotReadNeverReachTheCore() = runTest(StandardTestDispatcher()) {
        val pending = Pending()
        val m = model(pending)
        m.runFile(PickedFile("big.ics", "text/calendar", null, tooLarge = true), emptySet())
        assertEquals(Strings.Import.TOO_LARGE, m.error)
        m.runFile(PickedFile("gone.ics", "text/calendar", null), emptySet())
        assertEquals(Strings.Import.UNOPENABLE, m.error)
        m.runFile(PickedFile("empty.ics", "text/calendar", ByteArray(0)), emptySet())
        assertEquals(Strings.Import.EMPTY_FILE, m.error)
        advanceUntilIdle()
        assertTrue(pending.answers.isEmpty())
        assertFalse(m.busy)
    }
}
