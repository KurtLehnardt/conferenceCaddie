package app.conferencecaddie.ui.talks

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.LocalSaveableStateRegistry
import androidx.compose.runtime.saveable.SaveableStateRegistry
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi

@OptIn(ExperimentalTestApi::class)
actual class Restoration actual constructor(private val test: ComposeUiTest) {
    private var saved: Map<String, List<Any?>>? = null
    private var registry: SaveableStateRegistry? = null
    private var shown by mutableStateOf(true)

    // As StateRestorationTester does: the content leaves the composition and comes back at the same
    // place, so its saved values are found under the same keys.
    actual fun setContent(content: @Composable () -> Unit) = test.setContent {
        if (shown) {
            val r = remember { SaveableStateRegistry(saved) { true } }
            registry = r
            CompositionLocalProvider(LocalSaveableStateRegistry provides r) { content() }
        }
    }

    actual fun emulateSaveAndRestore() {
        test.runOnIdle {
            saved = registry!!.performSave()
            shown = false
        }
        test.waitForIdle()
        test.runOnIdle { shown = true }
        test.waitForIdle()
    }
}
