package app.conferencecaddie.ui

import androidx.activity.OnBackPressedDispatcherOwner
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.runtime.Composable

/** Android: the test activity's own back dispatcher, which the back button and gesture also use. */
actual class SystemBack actual constructor() {
    private var owner: OnBackPressedDispatcherOwner? = null

    @Composable
    actual fun Provide(content: @Composable () -> Unit) {
        owner = LocalOnBackPressedDispatcherOwner.current
        content()
    }

    actual fun press() {
        checkNotNull(owner) { "Provide() has not run" }.onBackPressedDispatcher.onBackPressed()
    }
}
