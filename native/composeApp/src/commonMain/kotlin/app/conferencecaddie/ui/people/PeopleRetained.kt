package app.conferencecaddie.ui.people

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
 * - [navigator], [openTalk] and [openUrl]: the shell's as they are now. A toast's "Open profile", or
 *   a Meet up opened by an Accept that finished after the re-creation, moves the screens that show,
 *   and nothing an action holds keeps the old activity alive.
 * - The host's memory ([memory]): the open sheets, the people waved at, the setup panels and the
 *   actions under way. An answer that closes a sheet changes the memory the new composition shows;
 *   a copy restored from saved state would still have it open.
 *
 * [PeopleViewModel] holds it in the activity's ViewModelStore, as the Search screen's model is held
 * (SearchViewModel), but unlike that model its work runs in a scope of its own (the ViewModel's),
 * since an answer must outlive the composition: it lives across a rotation and ends when the
 * activity finishes, so no answer is shown on a later visit (DECISIONS.md). Without a
 * ViewModelStoreOwner (previews, some tests) it lives as long as the composition, with the
 * composition's scope.
 */
class PeopleRetained(val scope: CoroutineScope) {
    // A toast the collector had taken but not shown when its composition went (a rotation at that
    // moment) is queued again for the next one, after any still waiting.
    private val queue: Channel<Pending> = Channel(Channel.UNLIMITED) { undelivered -> queue.trySend(undelivered) }

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

    /** The shell's "open this talk" of the composition that shows now; set by it. */
    @kotlin.concurrent.Volatile
    internal var currentOpenTalk: ((String) -> Unit)? = null

    /** The shell's "open this link" of the composition that shows now; set by it. */
    @kotlin.concurrent.Volatile
    internal var currentOpenUrl: ((String) -> Unit)? = null

    /** Opens a talk in whichever composition shows now. */
    internal val openTalk: (String) -> Unit = { currentOpenTalk?.invoke(it) }

    /** Opens a link from whichever composition shows now. */
    internal val openUrl: (String) -> Unit = { currentOpenUrl?.invoke(it) }

    /** The host's memory, once the first composition has made or restored it. */
    internal var memory: PeopleHostMemory? = null
}

/** Holds the [PeopleRetained] for as long as the activity's ViewModelStore lives (across a rotation). */
class PeopleViewModel : ViewModel() {
    val retained = PeopleRetained(viewModelScope)
}
