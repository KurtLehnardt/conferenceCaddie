package app.conferencecaddie.ui.people

import androidx.compose.runtime.Stable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.conferencecaddie.ui.shell.ShellNavigator
import app.conferencecaddie.ui.shell.ShellPage
import app.conferencecaddie.ui.shell.Tab
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow

/**
 * What the people screens keep while Android re-creates the activity (a rotation, a theme or a
 * locale change), when the composition, and every scope and object it remembered, starts over:
 *
 * - [scope], [PeopleHost.scope]: the scope an action's answer runs in. An action asked for before
 *   the re-creation still shows its toast, closes its panel or its sheet afterwards.
 * - The toasts ([post]): the answer is queued here and shown by whichever composition shows now
 *   ([toasts]); one shown by the composition that has gone would never be seen.
 * - [navigator]: the shell's navigation as it is now. A toast's "Open profile", or a Meet up opened
 *   by an Accept that finished after the re-creation, moves the screens that show.
 * - The host's memory ([memory]): the open sheets, the people waved at and the setup panels. An
 *   answer that closes a sheet changes the memory the new composition shows; a copy restored from
 *   saved state would still have it open.
 *
 * [PeopleViewModel] holds it for as long as the activity's ViewModelStore lives, as SearchViewModel
 * holds the Search screen's state: it outlives a rotation and ends when the activity finishes, so
 * no answer is shown on a later visit. Without a ViewModelStoreOwner (previews, some tests) it
 * lives as long as the composition, with the composition's scope.
 */
@Stable
class PeopleRetained(val scope: CoroutineScope) {
    private val queue = Channel<Pending>(Channel.UNLIMITED)

    /** A toast waiting to be shown. */
    internal class Pending(val message: String, val action: PeopleToastAction?)

    /** The toasts posted, each to be shown once by the composition that collects them. */
    internal val toasts: Flow<Pending> = queue.receiveAsFlow()

    /** Queues [message] (with [action]) for the composition that shows now. */
    internal fun post(message: String, action: PeopleToastAction?) {
        queue.trySend(Pending(message, action))
    }

    /** The shell's navigation of the composition that shows now; set by it. */
    @kotlin.concurrent.Volatile
    internal var current: ShellNavigator? = null

    /** Moves whichever composition shows now. */
    internal val navigator: ShellNavigator = object : ShellNavigator {
        override fun selectTab(tab: Tab) {
            current?.selectTab(tab)
        }

        override fun openSettings() {
            current?.openSettings()
        }

        override fun openSwitcher() {
            current?.openSwitcher()
        }

        override fun openPage(page: ShellPage) {
            current?.openPage(page)
        }

        override fun back() {
            current?.back()
        }
    }

    /** The host's memory, once the first composition has made or restored it. */
    internal var memory: PeopleHostMemory? = null
}

/** Holds the [PeopleRetained] for as long as the activity's ViewModelStore lives (across a rotation). */
class PeopleViewModel : ViewModel() {
    val retained = PeopleRetained(viewModelScope)
}
