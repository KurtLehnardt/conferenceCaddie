package app.conferencecaddie.ui.licenses

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.ui.theme.CaddieTheme
import kotlin.test.Test
import kotlin.test.assertTrue
import kotlin.time.TimeSource

// How long the licences screen takes to appear: the sections' first use (their text is prepared
// once per process) and the first frame of the lazy list, then a scroll to ONNX Runtime's notices.
// The numbers are printed, as LICENCES-TIMING, on each platform the UI tests run on.
@OptIn(ExperimentalTestApi::class)
class LicencesTimingTest {
    @Test
    fun theLicencesAppearQuickly() = runComposeUiTest {
        val start = TimeSource.Monotonic.markNow()
        val sections = Licenses.SECTIONS
        val prepared = start.elapsedNow()
        setContent { CaddieTheme { LicenceSections(Modifier.fillMaxSize().testTag("licences")) } }
        waitForIdle()
        val firstFrame = start.elapsedNow()
        onNodeWithTag("licences").performScrollToNode(hasText("ONNX Runtime (MIT) and the components it includes"))
        waitForIdle()
        val scrolled = start.elapsedNow()
        println(
            "LICENCES-TIMING sections=${sections.size} prepare_ms=${prepared.inWholeMilliseconds} " +
                "first_frame_ms=${firstFrame.inWholeMilliseconds} scrolled_ms=${scrolled.inWholeMilliseconds}",
        )
        assertTrue(sections.any { it.title.startsWith("ONNX Runtime") })
    }
}
