package app.conferencecaddie

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** SCRATCH (reverted before merge): fails on purpose, to show the CI emulator job does not retry a failing test. */
@RunWith(AndroidJUnit4::class)
class ScratchDeliberateFailureTest {
    @Test
    fun thisTestFailsOnPurpose() {
        assertEquals("a deliberate failure", "is still a failure")
    }
}
