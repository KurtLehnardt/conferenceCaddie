package app.conferencecaddie.ui.talks

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * A choice of the screens that is kept on this device, such as the theme or My schedule's view.
 * The stored choice is read once, at start, and the read takes a moment. A choice made on screen or
 * by a link before that read returns is newer than what the read returns, so it wins: [restore]
 * never puts the stored choice back over it. Used on the main thread only.
 */
@Stable
internal class StoredChoice<T>(initial: T) {
    var value: T by mutableStateOf(initial)
        private set

    // True once a choice was made here; the stored choice is older than it.
    private var chosen = false

    /** A choice made on screen or by a link. It wins over the stored choice, whenever that is read. */
    fun choose(choice: T) {
        chosen = true
        value = choice
    }

    /** Shows the stored choice that [read] returns (null when there is none), unless a choice was made meanwhile. */
    suspend fun restore(read: suspend () -> T?) {
        val stored = read() ?: return
        if (!chosen) value = stored
    }
}
