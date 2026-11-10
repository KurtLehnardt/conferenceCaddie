package app.conferencecaddie.ui

import androidx.compose.runtime.Composable

/**
 * The system Back for UI tests: Android's back button or gesture, or the iOS edge swipe. [Provide]
 * wraps the content under test and [press] sends one Back to its back handlers, on the UI thread.
 */
expect class SystemBack() {
    @Composable
    fun Provide(content: @Composable () -> Unit)

    fun press()
}
