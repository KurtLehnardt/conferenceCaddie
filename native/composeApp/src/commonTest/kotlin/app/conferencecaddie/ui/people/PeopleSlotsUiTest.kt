package app.conferencecaddie.ui.people

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.runtime.snapshots.SnapshotStateObserver
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.ui.shell.ShellNavigation
import app.conferencecaddie.ui.shell.rememberShellNavigation
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

// The slots the People layer hands the talk screens are the same lambdas on every recomposition,
// so a list holding them can skip.
@OptIn(ExperimentalTestApi::class)
class PeopleSlotsUiTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @AfterTest
    fun cleanUp() {
        scope.cancel()
    }

    @Test
    fun talkControlsAndShareAllAreTheSameInstanceAcrossRecompositionsAndStateChanges() = runComposeUiTest {
        val controller = testController(scope)
        var interested by mutableStateOf(emptyList<String>())
        val seenControls = ArrayList<Any>()
        val seenShareAll = ArrayList<Any>()
        val seenPrefetch = ArrayList<Any>()
        setContent {
            val ui = rememberPeopleUi(
                controller,
                rememberShellNavigation(),
                PeopleTalks(bundle = null, interested = interested, nowMs = 0),
                online = true,
                searchable = true,
                launch = null,
                showToast = { _, _, _ -> },
                openTalk = {},
                openUrl = {},
            )!!
            ui.talkControls?.let { seenControls += it }
            ui.shareAll?.let { seenShareAll += it }
            ui.prefetchCounts?.let { seenPrefetch += it }
        }
        scope.launch { controller.updateContext(peopleContext()) }
        waitUntil(timeoutMillis = 20_000) { seenControls.isNotEmpty() }
        // New inputs of every kind: the talks, then a state the controller publishes.
        interested = listOf("t1")
        waitForIdle()
        interested = listOf("t1", "t2")
        waitForIdle()

        assertTrue(seenControls.size >= 2, "composed ${seenControls.size} times")
        assertTrue(seenControls.all { it === seenControls.first() })
        assertTrue(seenShareAll.isNotEmpty() && seenShareAll.all { it === seenShareAll.first() })
        assertTrue(seenPrefetch.isNotEmpty() && seenPrefetch.all { it === seenPrefetch.first() })
    }

    /**
     * PeopleUi's init writes the inputs on every composition of the app. A reader of the slots'
     * inputs (what a slot's composition is) is told of a change only when the value is not equal to
     * the last one, so a recomposition that changes nothing does not recompose the slots.
     */
    @Test
    fun aSlotsReaderIsToldOfNewInputsAndNotOfAnEqualUpdate() {
        val controller = testController(scope)
        val slots = PeopleSlots(PeopleHost(controller, ShellNavigation(), scope, { _, _ -> }, {}, {}))
        val state = controller.state.value
        fun inputs(interested: List<String>) = PeopleInputs(state, PeopleTalks(bundle = null, interested = interested, nowMs = 0), online = false, searchable = true)
        slots.update(inputs(emptyList()))
        Snapshot.sendApplyNotifications()

        var told = 0
        val observer = SnapshotStateObserver { it() }
        observer.start()
        try {
            observer.observeReads(this, { told++ }) { slots.inputs() }
            slots.update(inputs(emptyList()))
            slots.update(inputs(emptyList()))
            Snapshot.sendApplyNotifications()
            assertEquals(0, told, "an equal update told the reader")

            slots.update(inputs(listOf("t1")))
            Snapshot.sendApplyNotifications()
            assertEquals(1, told, "a changed input did not tell the reader")
        } finally {
            observer.stop()
            observer.clear(this)
        }
    }
}
