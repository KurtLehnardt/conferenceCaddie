package app.conferencecaddie.ui.talks

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import kotlin.time.Clock

class ToastIdsTest {
    @Test
    fun twoToastsInTheSameMillisecondGetDifferentIds() {
        val ids = ToastIds()
        // Two toasts made back to back, until a pair falls within one millisecond of the clock: the
        // pair a time-based id would have given the same id.
        var pair = ids.toast("Marked", "Undo") to ids.toast("Unmarked", "Undo")
        var sameMs = false
        repeat(1_000) {
            if (sameMs) return@repeat
            val before = Clock.System.now().toEpochMilliseconds()
            pair = ids.toast("Marked", "Undo") to ids.toast("Unmarked", "Undo")
            sameMs = Clock.System.now().toEpochMilliseconds() == before
        }
        assertTrue(sameMs, "no two toasts were made within one millisecond")
        assertNotEquals(pair.first.id, pair.second.id)
        assertEquals("Unmarked", pair.second.message)
        assertEquals("Undo", pair.second.actionLabel)
    }
}
