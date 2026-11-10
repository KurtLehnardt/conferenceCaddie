package app.conferencecaddie.ui.talks

import app.conferencecaddie.shared.search.ForYou
import app.conferencecaddie.ui.strings.Strings
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

// For you when working out the suggestions fails: the list on screen stays, the error says so, and
// the next refresh tries again, the same inputs included.
class ForYouModelTest {
    private val list = ForYou.Result.Ready(items = emptyList(), degraded = false)

    @Test
    fun aFailedRefreshKeepsTheLastListAndTheNextOneTriesAgain() = runTest {
        var fail = false
        var runs = 0
        val model = ForYouModel(this) {
            runs++
            if (fail) error("the search failed")
            list
        }
        model.refresh("kubecon", 1)
        advanceUntilIdle()
        assertSame(list, model.result)
        assertNull(model.error)

        fail = true
        model.refresh("kubecon", 2)
        advanceUntilIdle()
        assertSame(list, model.result, "the earlier list stays")
        assertEquals(Strings.ForYou.ERROR, model.error)
        assertFalse(model.refreshing)

        fail = false
        model.refresh("kubecon", 2)
        advanceUntilIdle()
        assertEquals(3, runs, "the same inputs are asked again after a failure")
        assertSame(list, model.result)
        assertNull(model.error)
    }

    @Test
    fun aFailureWithNothingYetShowsTheErrorAndAnotherConferenceStartsClean() = runTest {
        var fail = true
        val model = ForYouModel(this) { if (fail) throw IllegalStateException("no bundle") else list }
        model.refresh("kubecon", 1)
        advanceUntilIdle()
        assertNull(model.result)
        assertEquals(Strings.ForYou.ERROR, model.error)
        assertFalse(model.refreshing)

        fail = false
        model.refresh("grpconf", 1)
        assertNull(model.error, "another conference does not show the last one's error")
        advanceUntilIdle()
        assertSame(list, model.result)
    }

    @Test
    fun aRefreshThatIsReplacedIsNotAnError() = runTest {
        val gate = CompletableDeferred<Unit>()
        var first = true
        val model = ForYouModel(this) {
            if (first) {
                first = false
                gate.await()
            }
            list
        }
        model.refresh("kubecon", 1)
        advanceUntilIdle()
        // The first run waits; a new input cancels it, and the cancellation is not reported.
        model.refresh("kubecon", 2)
        advanceUntilIdle()
        assertNull(model.error)
        assertSame(list, model.result)
        assertFalse(model.refreshing)
    }
}
