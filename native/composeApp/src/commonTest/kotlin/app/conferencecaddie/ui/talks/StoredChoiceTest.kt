package app.conferencecaddie.ui.talks

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest

// A choice kept on the device is read once at start; a choice made before that read returns wins.
class StoredChoiceTest {
    @Test
    fun theStoredChoiceIsShownWhenNoneWasMade() = runTest {
        val choice = StoredChoice("list")
        choice.restore { "day" }
        assertEquals("day", choice.value)
    }

    @Test
    fun nothingStoredKeepsTheFirstChoice() = runTest {
        val choice = StoredChoice("list")
        choice.restore { null }
        assertEquals("list", choice.value)
    }

    @Test
    fun aChoiceMadeWhileTheStoredOneIsReadWins() = runTest {
        val choice = StoredChoice("system")
        val stored = CompletableDeferred<String?>()
        val restoring = launch { choice.restore { stored.await() } }
        testScheduler.runCurrent()
        // The read has started and not returned: the person chooses, then the older choice comes back.
        choice.choose("dark")
        assertEquals("dark", choice.value)
        stored.complete("light")
        restoring.join()
        assertEquals("dark", choice.value, "the stored choice is older than the one made on screen")
    }

    @Test
    fun aChoiceMadeAfterTheStoredOneWasShownReplacesIt() = runTest {
        val choice = StoredChoice("system")
        choice.restore { "light" }
        choice.choose("dark")
        assertEquals("dark", choice.value)
    }
}
