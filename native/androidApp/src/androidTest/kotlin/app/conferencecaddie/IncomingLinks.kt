package app.conferencecaddie

import app.conferencecaddie.ui.platform.Incoming
import app.conferencecaddie.ui.platform.IncomingHandoff
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

/** The links MainActivity hands to the app's link hand-off, for the instrumented tests. */
internal object IncomingLinks {
    /**
     * Adds every link handed to [IncomingHandoff] from now on to [into], until the returned job is
     * cancelled. The hand-off's latest value cannot tell: the app takes each link as soon as it is
     * composed. The watch is unconfined, so it sees each link in the thread that hands it over,
     * before the app can take it, and it is in place when this returns.
     */
    fun watch(into: MutableList<String>): Job = CoroutineScope(Dispatchers.Unconfined).launch {
        // The first value is whatever was waiting before the test.
        IncomingHandoff.latest.drop(1).collect { item -> if (item is Incoming.Link) into += item.url }
    }
}
