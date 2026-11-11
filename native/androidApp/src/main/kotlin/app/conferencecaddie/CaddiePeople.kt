package app.conferencecaddie

import android.content.Context
import android.content.pm.ApplicationInfo
import app.conferencecaddie.shared.AndroidPeopleServices
import app.conferencecaddie.shared.core.AndroidCore
import app.conferencecaddie.shared.people.PeopleController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * The process's people features, created once and shared by the activity and the background nudge
 * job. The job can start a cold process with no activity, so it must reach the same controller the
 * app uses, built the same way ([AndroidCore.people] with the app's debuggable flag), and must never
 * create a second set of platform services. The first call creates the controller and starts the
 * [BackgroundNudgeScheduler] that follows its state.
 */
object CaddiePeople {
    @Volatile private var instance: PeopleController? = null

    /** True in debug builds, which may reach a backend over plain http on the developer's machine. */
    fun allowLocalHttp(context: Context): Boolean =
        (context.applicationContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    /** The process's controller. Opens the database and the secure store on first use: call it off the main thread where that matters. */
    fun controller(context: Context): PeopleController = instance ?: synchronized(this) {
        instance ?: run {
            val app = context.applicationContext
            val controller = AndroidCore.people(app, AndroidPeopleServices.create(app, R.drawable.ic_stat_caddie), allowLocalHttp(app))
            scheduler = BackgroundNudgeScheduler(app, controller.state, CoroutineScope(SupervisorJob() + Dispatchers.Default)).also { it.start() }
            instance = controller
            controller
        }
    }

    @Volatile private var scheduler: BackgroundNudgeScheduler? = null

    /**
     * Checks again whether the background nudge job is wanted, when the app comes back to the
     * foreground: the system's notification switch may have changed while it was away, which no
     * people state shows. Does nothing before the controller exists.
     */
    fun recheckBackgroundNudges() {
        scheduler?.recheck()
    }
}
