package app.conferencecaddie.ui.talks

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.StateRestorationTester

@OptIn(ExperimentalTestApi::class)
actual class Restoration actual constructor(test: ComposeUiTest) {
    private val tester = StateRestorationTester(test)

    actual fun setContent(content: @Composable () -> Unit) = tester.setContent(content)

    actual fun emulateSaveAndRestore() = tester.emulateSaveAndRestore()
}
