package app.conferencecaddie.ui.talks

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi

/**
 * Disposes the content and composes it again from its saved state, as a configuration change
 * does to an Android activity. On Android it is Compose's StateRestorationTester, which also
 * passes the state through a Bundle; the skiko test library leaves that tester unimplemented, so
 * on iOS it saves and restores through a SaveableStateRegistry of its own.
 */
@OptIn(ExperimentalTestApi::class)
expect class Restoration(test: ComposeUiTest) {
    fun setContent(content: @Composable () -> Unit)

    fun emulateSaveAndRestore()
}
