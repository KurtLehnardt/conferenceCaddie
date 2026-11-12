package app.conferencecaddie.ui.people

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteraction
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleTestHook
import kotlinx.coroutines.CompletableDeferred

/**
 * The next action [controller] runs for a screen once [until] is true, held at
 * [PeopleController.beforeActionReturns]: it has published what it changed, so the screens already
 * show it, and its caller is still waiting until [release]. [until] names the action by what it
 * did (a request sent, the state it published), so a write some other part of the screen makes
 * meanwhile passes through. Only that one action is held.
 */
@OptIn(PeopleTestHook::class)
internal class HeldAction(controller: PeopleController, until: () -> Boolean) {
    private val arrived = CompletableDeferred<Unit>()
    private val gate = CompletableDeferred<Unit>()

    /** True once the action has reached the hold. */
    val hasArrived: Boolean get() = arrived.isCompleted

    init {
        controller.beforeActionReturns = {
            if (until()) {
                controller.beforeActionReturns = {}
                arrived.complete(Unit)
                gate.await()
            }
        }
    }

    /** Lets the action return to its caller. */
    fun release() {
        gate.complete(Unit)
    }
}

/**
 * Two taps on [node] handled one after the other before anything else runs on the UI thread, as
 * when both reach the app in one frame: the first one's action has not started when the second
 * comes. (Injected touches would let the test's clock run, and the first action start, between
 * the two.)
 */
@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.doubleTap(node: SemanticsNodeInteraction) {
    val click = node.fetchSemanticsNode().config[SemanticsActions.OnClick].action ?: error("Not clickable")
    runOnUiThread {
        click()
        click()
    }
}
