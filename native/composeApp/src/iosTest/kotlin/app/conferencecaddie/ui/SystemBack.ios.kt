package app.conferencecaddie.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.navigationevent.DirectNavigationEventInput
import androidx.navigationevent.NavigationEventDispatcher
import androidx.navigationevent.NavigationEventDispatcherOwner
import androidx.navigationevent.compose.LocalNavigationEventDispatcherOwner

/**
 * iOS: a navigation event dispatcher of the test's own, which the shell's back handler registers
 * with as it does with the app's, where UIKit's edge swipe sends the event.
 */
actual class SystemBack actual constructor() {
    private val dispatcher = NavigationEventDispatcher()
    private val input = DirectNavigationEventInput()
    private val owner = object : NavigationEventDispatcherOwner {
        override val navigationEventDispatcher = dispatcher
    }

    init {
        dispatcher.addInput(input)
    }

    @Composable
    actual fun Provide(content: @Composable () -> Unit) {
        CompositionLocalProvider(LocalNavigationEventDispatcherOwner provides owner, content = content)
    }

    actual fun press() {
        input.backCompleted()
    }
}
