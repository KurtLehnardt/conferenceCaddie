package app.conferencecaddie.shared

import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The bridge between the platform services and the activity that can show the system's permission
 * prompts. Android shows them only from an activity, through an ActivityResult launcher that the
 * activity registers before it starts, so MainActivity registers one and attaches it here for as
 * long as it exists. The services ask through [request]; with no activity attached they get an
 * empty answer and read the permission state themselves.
 *
 * The object outlives the activity on purpose: when the activity is re-created while a prompt is
 * showing, the new activity's launcher receives the answer and [deliver] completes the waiting
 * request.
 */
object AndroidPermissions {
    /** What the activity provides. */
    interface Host {
        /** Launches the system prompt for [permissions]; the answer must reach [deliver]. */
        fun launch(permissions: Array<String>)

        /** Android's `shouldShowRequestPermissionRationale`: true when asking again shows the prompt. */
        fun shouldShowRationale(permission: String): Boolean
    }

    private val main = Handler(Looper.getMainLooper())
    private val oneAtATime = Mutex()

    @Volatile private var host: Host? = null

    @Volatile private var pending: CompletableDeferred<Map<String, Boolean>>? = null

    /** Called by the activity in onCreate. */
    fun attach(host: Host) {
        this.host = host
    }

    /**
     * Called by the activity in onDestroy. When it is [finishing] (not about to be re-created), a
     * request still waiting for an answer gets an empty one, so it does not wait forever.
     */
    fun detach(host: Host, finishing: Boolean) {
        if (this.host !== host) return
        this.host = null
        if (finishing) pending?.complete(emptyMap())
    }

    /** Called with the launcher's answer: each permission asked for and whether it is granted. */
    fun deliver(result: Map<String, Boolean>) {
        pending?.complete(result)
    }

    /**
     * Shows the system prompt for [permissions] (one prompt at a time) and returns the answer. The
     * system answers at once, without a prompt, for permissions already granted or refused for good.
     */
    suspend fun request(vararg permissions: String): Map<String, Boolean> = oneAtATime.withLock {
        val waiter = CompletableDeferred<Map<String, Boolean>>()
        pending = waiter
        try {
            main.post {
                val current = host
                try {
                    if (current == null) waiter.complete(emptyMap()) else current.launch(arrayOf(*permissions))
                } catch (e: IllegalStateException) {
                    // The launcher refuses once its activity is being destroyed.
                    waiter.complete(emptyMap())
                }
            }
            waiter.await()
        } finally {
            if (pending === waiter) pending = null
        }
    }

    /** Whether asking again for [permission] would show the prompt; null with no activity attached. */
    internal fun shouldShowRationale(permission: String): Boolean? = host?.shouldShowRationale(permission)
}
