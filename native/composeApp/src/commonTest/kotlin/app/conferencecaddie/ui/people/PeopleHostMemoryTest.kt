package app.conferencecaddie.ui.people

import androidx.compose.runtime.saveable.SaverScope
import app.conferencecaddie.shared.people.ReportKind
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

// The host's memory through its Saver, as Android saves it when the activity goes and restores it
// after the process was ended, and through retainedSaver, which finds the very memory again after a
// re-creation instead.
class PeopleHostMemoryTest {
    private val scope = CoroutineScope(Job())

    @AfterTest
    fun cleanUp() = scope.cancel()

    private val saving = object : SaverScope {
        override fun canBeSaved(value: Any) = true
    }

    private fun save(m: PeopleHostMemory): Any = with(PeopleHostMemory.Saver) { saving.save(m) }!!

    private fun memory() = PeopleHostMemory().apply {
        askingRef = "ref-ada"
        reporting = ReportTarget("ref-cy", "Cy Seed", ReportKind.Spot, "ref-cy")
        blocking = BlockTarget("ref-dee", "Dee Seed")
        waved = setOf("ref-eve")
        request = PeopleRequest(aroundNow = true, query = "ebpf", hereZone = "Hallway", id = 7)
        askSent = "ref-ada"
        panels = mapOf(SetupPanel.Presence to "token-1", SetupPanel.BluetoothSettings to "token=2")
        check(start("presence"))
    }

    @Test
    fun aSavedMemoryComesBackWithItsSheetsAndPanels() {
        val restored = PeopleHostMemory.Saver.restore(save(memory()))!!
        assertEquals("ref-ada", restored.askingRef)
        assertEquals(ReportTarget("ref-cy", "Cy Seed", ReportKind.Spot, "ref-cy"), restored.reporting)
        assertEquals("ref-dee", restored.blocking?.ref)
        assertEquals("Dee Seed", restored.blocking?.name)
        assertEquals(setOf("ref-eve"), restored.waved)
        assertEquals(PeopleRequest(aroundNow = true, query = "ebpf", hereZone = "Hallway", id = 7), restored.request)
        assertEquals("ref-ada", restored.askSent)
        // A token may hold the separator; only the first one splits.
        assertEquals(mapOf(SetupPanel.Presence to "token-1", SetupPanel.BluetoothSettings to "token=2"), restored.panels)
        // An action under way ends with the process: nothing is under way after a restore.
        assertTrue(restored.running.isEmpty())
        assertTrue(restored.start("presence"))
    }

    @Test
    fun theFoundViewsAndThePeopleSavedFromThemAreSaved() {
        val m = PeopleHostMemory().apply {
            found = mapOf("meet-1" to listOf("Ada Seed", null), "meet-2" to listOf("Bea Seed", "Designer."))
            metSaved = setOf("meet-2")
        }
        val restored = PeopleHostMemory.Saver.restore(save(m))!!
        assertEquals(mapOf("meet-1" to listOf("Ada Seed", null), "meet-2" to listOf("Bea Seed", "Designer.")), restored.found)
        assertEquals(setOf("meet-2"), restored.metSaved)
    }

    @Test
    fun anActionOnAScopeThatHasEndedDoesNotStayUnderWay() = runTest {
        val ended = CoroutineScope(Job().apply { cancel() })
        val clock = TestClock()
        val controller = testPeopleController(FakePeopleServer({ clock.ms }, FakeConference.alpha()), scope, clock)
        val host = PeopleHost(controller, app.conferencecaddie.ui.shell.ShellNavigation(), ended, { _, _ -> }, {}, {})
        assertTrue(host.launchOnce("presence") {})
        // The scope could not run it, so its name is soon free again, and the next tap is not refused.
        withContext(Dispatchers.Default) {
            withTimeout(10_000) {
                while (host.isRunning("presence")) delay(10)
            }
        }
        assertFalse(host.isRunning("presence"))
        controller.close()
    }

    @Test
    fun stateSavedBeforeThePanelsWereKeptStillRestores() {
        // The five entries an earlier version saved.
        val saved = arrayListOf<Any?>("ref-ada", null, null, arrayListOf("ref-eve"), null)
        val restored = PeopleHostMemory.Saver.restore(saved)!!
        assertEquals("ref-ada", restored.askingRef)
        assertEquals(setOf("ref-eve"), restored.waved)
        assertNull(restored.askSent)
        assertTrue(restored.panels.isEmpty())
    }

    @Test
    fun aRestoreAfterARecreationFindsTheRetainedMemory() {
        val retained = PeopleRetained(scope)
        val kept = memory()
        retained.memory = kept
        // Whatever the saved state says, the composition goes on with the memory the actions change.
        val restored = PeopleHostMemory.retainedSaver(retained).restore(save(PeopleHostMemory()))
        assertSame(kept, restored)
        assertTrue(restored!!.running.contains("presence"))
    }

    @Test
    fun aRestoreAfterTheProcessEndedReadsTheSavedStateAndKeepsIt() {
        val retained = PeopleRetained(scope)
        val restored = PeopleHostMemory.retainedSaver(retained).restore(save(memory()))!!
        assertEquals("ref-ada", restored.askingRef)
        assertEquals(mapOf(SetupPanel.Presence to "token-1", SetupPanel.BluetoothSettings to "token=2"), restored.panels)
        assertSame(restored, retained.memory)
    }
}
