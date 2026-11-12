package app.conferencecaddie.ui.people

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import app.conferencecaddie.shared.AppLink
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.people.Person
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.ReportKind
import app.conferencecaddie.ui.shell.PeoplePage
import app.conferencecaddie.ui.shell.ShellNavigator
import app.conferencecaddie.ui.shell.Tab
import kotlin.concurrent.atomics.AtomicReference
import kotlin.concurrent.atomics.ExperimentalAtomicApi
import kotlin.random.Random
import kotlin.reflect.KProperty
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * What every people screen gets besides the state: the [controller] and the app around it. Screens
 * take it as a parameter, next to the `PeopleUiState` they draw, and never reach for the app in any
 * other way:
 *
 * - [controller]: the people features. Its actions are suspend functions. Start an action whose
 *   answer must still be shown after its composable has left (a card in a list, a row the answer
 *   removes, Back, another tab, a rotation) with [launchOnce], or on [scope]; reads that end with a
 *   screen can use a `rememberCoroutineScope()` of the screen.
 * - Moving around: [openProfile], [openInbox], [openMeet], [openPeople], [openSettings] and [back].
 * - The shell's one toast: [showToast], and [showMessage] for an action's message.
 * - The sheets and the dialog that more than one screen opens, drawn once by the People layer:
 *   [ask] (AskSheet), [report] (ReportSheet) and [confirmBlock] (the block confirmation, then the
 *   block, its toast and Undo).
 * - Talks and links: [openTalk] opens the talk sheet; [openUrl] opens an http(s) link.
 * - What this run remembers across screens: [hasWaved] and [markWaved] ("Waved" on a card),
 *   the actions under way ([isRunning]) and the open setup panels ([rememberPanel]).
 * - The platform: [nowMs] (the controller's clock, so a test's clock reaches the screens too) and
 *   [openAppSettings] (this app's page in the system settings, where [canOpenAppSettings]).
 *
 * One instance lives as long as the app's composition. What it remembers is in its memory
 * ([PeopleHostMemory]), which [PeopleRetained] keeps across the activity's re-creation on Android.
 */
@Stable
class PeopleHost(
    val controller: PeopleController,
    private val navigator: ShellNavigator,
    /**
     * The scope of [PeopleRetained]: on Android it lives as long as the activity's ViewModelStore,
     * across a rotation (else as long as the app's composition). For work that must finish after a
     * screen leaves (`controller.setInboxVisible(false)` from a DisposableEffect), and for an action
     * whose answer must still be shown after its composable has left, or after the answer itself
     * removed it ([launchOnce]). Reads that end with a screen use the screen's own scope.
     */
    val scope: CoroutineScope,
    private val toast: (message: String, action: PeopleToastAction?) -> Unit,
    /** Opens the talk with this id in the talk sheet. */
    val openTalk: (talkId: String) -> Unit,
    /** Opens an http(s) link in the browser; nothing else is opened. */
    val openUrl: (url: String) -> Unit,
    /**
     * What the host keeps across an activity's re-creation: pass the one from [rememberPeopleUi]
     * (saved with the instance state) so the open sheets and the pending request come back.
     */
    private val memory: PeopleHostMemory = PeopleHostMemory(),
) {
    // ---------------------------------------------------------------------------------------------
    // Moving around

    /** Profile (#/profile), from "Create my profile" or "Open my profile". */
    fun openProfile() = navigator.openPage(PeoplePage.Profile)

    /** True when the controller says the fix for an action's [message] is on the profile screen, so the screen offers "Open my profile" with it. */
    fun opensProfile(message: String): Boolean = controller.opensProfile(message)

    /** "Try again" on the People tab when the records could not be opened: asks the controller to open them now. */
    fun retrySession() {
        scope.launch { controller.retrySession() }
    }

    /** Requests (#/inbox). */
    fun openInbox() = navigator.openPage(PeoplePage.Inbox)

    /** Meet up (#/meet/{id}), from "Open meet-up" or Accept. */
    fun openMeet(meetId: String) = navigator.openPage(PeoplePage.Meet(meetId))

    /** Settings, for example from "Saved under Settings". */
    fun openSettings() = navigator.openSettings()

    /**
     * The People tab, leaving every page ("Back to People"). With [request], the People screen also
     * does what it asks once it shows (a search from a topic chip, "Around now" from a nudge).
     */
    fun openPeople(request: PeopleRequest? = null) {
        if (request != null) memory.request = request
        navigator.selectTab(Tab.People)
    }

    /** Leaves the page showing, as the system Back does. */
    fun back() = navigator.back()

    /** What the People screen should do when it next shows, or null; see [requestHandled]. */
    val request: PeopleRequest? get() = memory.request

    /** The People screen did what [handled] asked; a newer request stays. */
    fun requestHandled(handled: PeopleRequest) {
        if (memory.request == handled) memory.request = null
    }

    // ---------------------------------------------------------------------------------------------
    // Toasts

    /** Shows [message] in the shell's toast, with an optional action such as Undo. */
    fun showToast(message: String, action: PeopleToastAction? = null) = toast(message, action)

    /**
     * An action's message as a toast, with "Open profile" when the fix is on the profile screen
     * ([opensProfile]), as a screen that shows the message itself offers it.
     */
    fun showMessage(message: String) =
        showToast(message, if (opensProfile(message)) PeopleToastAction(PeopleCommonStrings.OPEN_PROFILE, ::openProfile) else null)

    /**
     * A refused permission's words as a toast, with "Open settings" where this platform can open the
     * app's page in the system settings, as a screen that shows the words itself offers it.
     */
    fun showPermissionProblem(message: String) =
        showToast(message, if (canOpenAppSettings) PeopleToastAction(ConnectStrings.OPEN_SETTINGS, ::openAppSettings) else null)

    // ---------------------------------------------------------------------------------------------
    // Sheets and dialogs that more than one screen opens

    // The person asked of is kept by ref only; the object is the one given to ask(), or, after the
    // activity was re-created, the person found again among the people the controller has seen.
    private var askedPerson: Person? = null

    /** The ref "Ask to talk shop" is open for, or null. */
    val askingRef: String? get() = memory.askingRef

    /**
     * The person "Ask to talk shop" is open for, or null. After a re-creation it is looked up among
     * the people around and then among everyone the controller has seen while the app ran (a search,
     * a talk circle: [PeopleController.knownPerson]); null while the ref is open but the person is not
     * known, as after the process was ended.
     */
    val asking: Person?
        get() {
            val ref = memory.askingRef ?: return null
            askedPerson?.takeIf { it.ref == ref }?.let { return it }
            return controller.state.value.around.people.firstOrNull { it.ref == ref } ?: controller.knownPerson(ref)
        }

    /** Opens AskSheet for [person]. */
    fun ask(person: Person) {
        askedPerson = person
        memory.askingRef = person.ref
        memory.askSent = null
    }

    fun closeAsk() {
        askedPerson = null
        memory.askingRef = null
        memory.askSent = null
    }

    /**
     * True when the ask of the sheet open for [ref] was sent. Kept in the memory rather than in the
     * sheet: an ask that is answered after a re-creation shows "Asked" in the sheet that shows now.
     */
    fun askSent(ref: String): Boolean = memory.askSent == ref

    /** The ask to [ref] was sent; the sheet open for it says so. */
    fun markAskSent(ref: String) {
        if (memory.askingRef == ref) memory.askSent = ref
    }

    /**
     * Whether a setup panel ([which]) is open, for the composable that calls it. The panel is open
     * in the memory, which an answer after the activity was re-created still reaches (a copy of the
     * card's own saved state would keep it open), under a token the card keeps in its saved state.
     * The token comes back with the card after a re-creation, or a list that scrolled it away, so
     * the panel does too; a card that starts over (its tab was left) has a new one, so the panel
     * is closed there, as its draft is gone.
     */
    @Composable
    internal fun rememberPanel(which: SetupPanel): OpenPanel {
        val token = rememberSaveable { Random.nextLong().toString() }
        return remember(which, token) { OpenPanel(memory, which, token) }
    }

    /** Whether the action named [key] ([launchOnce]) is under way. */
    fun isRunning(key: String): Boolean = key in memory.running

    /**
     * Starts [action] on [scope] as the action named [key], unless an action of that name is under
     * way: started here, or by a screen that has gone since (it was left and opened again, or the
     * activity was re-created). Returns false when it did not start. The names live in the memory,
     * so a screen that came back waits for the answer of the action its predecessor started, as the
     * screen that asked would have.
     */
    fun launchOnce(key: String, action: suspend () -> Unit): Boolean {
        if (!memory.start(key)) return false
        scope.launch {
            try {
                action()
            } finally {
                memory.finish(key)
            }
        }
        return true
    }


    /** What ReportSheet is open for, or null. */
    val reporting: ReportTarget? get() = memory.reporting

    /** Opens ReportSheet for [target]. */
    fun report(target: ReportTarget) {
        memory.reporting = target
    }

    fun closeReport() {
        memory.reporting = null
    }

    /** The person the block confirmation is open for, or null. */
    val blocking: BlockTarget? get() = memory.blocking

    /**
     * Blocks [name] (connect.ts blockWithConfirm): asks first ("Block {name}?"), then blocks, which
     * drops them from every list at once, and toasts "Blocked {name}" with Undo; a refusal brings
     * them back and toasts the web's message. [after] runs once the person confirmed, before the
     * server answers, for a screen that drops a card of its own (an incoming ask).
     */
    fun confirmBlock(ref: String, name: String, after: () -> Unit = {}) {
        memory.blocking = BlockTarget(ref, name, after)
    }

    fun closeBlock() {
        memory.blocking = null
    }

    /** The confirmation's Block: runs the block of [target]. */
    internal fun block(target: BlockTarget) {
        memory.blocking = null
        target.after()
        scope.launch {
            val message = controller.block(target.ref, target.name)
            if (message == null) {
                showToast(
                    PeopleCommonStrings.blocked(target.name),
                    PeopleToastAction(PeopleCommonStrings.UNDO) {
                        scope.launch {
                            // As on the web, a failed Undo says nothing; the block stands.
                            if (controller.unblock(target.ref) == null) showToast(PeopleCommonStrings.unblocked(target.name))
                        }
                    },
                )
            } else {
                showToast(message)
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // The platform

    /**
     * The time now in epoch milliseconds, from the controller's clock: "Turns off in {n} min",
     * "Expires in {n} min" and "About {n} min left" agree with the times the server sent.
     */
    fun nowMs(): Long = controller.clock.now().toEpochMilliseconds()

    /** True where the platform can open this app's page in the system settings. */
    val canOpenAppSettings: Boolean get() = controller.systemSettings != null

    /**
     * Opens this app's page in the system settings (PeopleServices.systemSettings), where a refused
     * location or notification permission is allowed again. Does nothing where there is none.
     */
    fun openAppSettings() {
        controller.systemSettings?.openAppSettings()
    }

    // ---------------------------------------------------------------------------------------------
    // What this run remembers

    /** True when this run waved at [ref], so their card says "Waved" rather than "No reply yet". */
    fun hasWaved(ref: String): Boolean = ref in memory.waved

    fun markWaved(ref: String) {
        memory.waved = memory.waved + ref
    }
}

/**
 * The host's state that survives an activity's re-creation: the refs and small values of the open
 * sheets and setup panels, the pending request, the refs waved at and the actions under way,
 * never a person or a screen's data. [PeopleRetained] keeps the
 * very instance across a re-creation (an action that outlives it still changes what the new
 * composition shows); [Saver] saves it for the process's end, without the actions under way, which
 * end with the process. The block confirmation's `after` callback belongs to a screen that is
 * composed again; it is not saved, so a confirmation restored after the process ended blocks
 * without it (the card it would drop comes back with the next inbox refresh).
 */
@Stable
class PeopleHostMemory {
    internal var askingRef: String? by mutableStateOf(null)
    internal var reporting: ReportTarget? by mutableStateOf(null)
    internal var blocking: BlockTarget? by mutableStateOf(null)
    internal var waved: Set<String> by mutableStateOf(emptySet())
    internal var request: PeopleRequest? by mutableStateOf(null)
    internal var askSent: String? by mutableStateOf(null)

    /** The token of the card whose setup panel is open, per panel ([PeopleHost.rememberPanel]). */
    internal var panels: Map<SetupPanel, String> by mutableStateOf(emptyMap())

    // The actions under way ([PeopleHost.launchOnce]). The atomic set decides; [running] mirrors it
    // for the screens to read. Not saved: an action ends with the process.
    @OptIn(ExperimentalAtomicApi::class)
    private val runningNow = AtomicReference<Set<String>>(emptySet())
    internal var running: Set<String> by mutableStateOf(emptySet())
        private set

    @OptIn(ExperimentalAtomicApi::class)
    internal fun start(key: String): Boolean {
        while (true) {
            val now = runningNow.load()
            if (key in now) return false
            if (runningNow.compareAndSet(now, now + key)) break
        }
        running = runningNow.load()
        return true
    }

    @OptIn(ExperimentalAtomicApi::class)
    internal fun finish(key: String) {
        while (true) {
            val now = runningNow.load()
            if (runningNow.compareAndSet(now, now - key)) break
        }
        running = runningNow.load()
    }

    companion object {
        /**
         * [Saver], except that a restore finds [retained]'s memory when it has one: after a
         * re-creation the composition goes on with the very memory the actions still change, and a
         * restore from saved state happens only once the process was ended.
         */
        internal fun retainedSaver(retained: PeopleRetained): Saver<PeopleHostMemory, Any> = Saver(
            save = { m -> with(Saver) { save(m) } },
            restore = { saved -> retained.memory ?: Saver.restore(saved)?.also { retained.memory = it } },
        )

        val Saver: Saver<PeopleHostMemory, Any> = Saver(
            save = { m ->
                arrayListOf<Any?>(
                    m.askingRef,
                    m.reporting?.let { arrayListOf(it.ref, it.name, it.kind.name, it.id) },
                    m.blocking?.let { arrayListOf(it.ref, it.name) },
                    ArrayList(m.waved),
                    m.request?.let { arrayListOf(it.aroundNow, it.query, it.hereZone, it.id) },
                    arrayListOf(m.askSent, ArrayList(m.panels.map { (k, v) -> "${k.name}=$v" })),
                )
            },
            restore = { saved ->
                val list = saved as List<*>
                PeopleHostMemory().also { m ->
                    m.askingRef = list[0] as String?
                    (list[1] as List<*>?)?.let { r ->
                        val kind = ReportKind.entries.firstOrNull { it.name == r[2] }
                        if (kind != null) m.reporting = ReportTarget(r[0] as String, r[1] as String, kind, r[3] as String)
                    }
                    (list[2] as List<*>?)?.let { b -> m.blocking = BlockTarget(b[0] as String, b[1] as String) }
                    m.waved = (list[3] as List<*>).filterIsInstance<String>().toSet()
                    (list[4] as List<*>?)?.let { q ->
                        m.request = PeopleRequest(q[0] as Boolean, q[1] as String?, q[2] as String?, q[3] as Long)
                    }
                    // Absent from state saved before these were kept.
                    (list.getOrNull(5) as List<*>?)?.let { p ->
                        m.askSent = p.getOrNull(0) as? String
                        m.panels = (p.getOrNull(1) as? List<*>).orEmpty().filterIsInstance<String>().mapNotNull { e ->
                            val (name, token) = e.split('=', limit = 2).takeIf { it.size == 2 } ?: return@mapNotNull null
                            SetupPanel.entries.firstOrNull { it.name == name }?.let { it to token }
                        }.toMap()
                    }
                }
            },
        )
    }
}

/**
 * The time now in epoch milliseconds from [PeopleHost.nowMs], read again every [periodMs] while
 * [active] (the web's 30-second minute tick) and whenever [key] changes, such as a new end time.
 */
@Composable
internal fun rememberNowMs(host: PeopleHost, active: Boolean, key: Any? = null, periodMs: Long = 30_000): Long {
    val now by produceState(host.nowMs(), host, active, key) {
        value = host.nowMs()
        while (active) {
            delay(periodMs)
            value = host.nowMs()
        }
    }
    return now
}

/** A toast's action button, such as Undo. */
@Immutable
data class PeopleToastAction(val label: String, val onClick: () -> Unit)

/** Who the block confirmation is about. [ref] is a key only and never shown. */
@Immutable
data class BlockTarget(val ref: String, val name: String, val after: () -> Unit = {})

/** What ReportSheet reports (web ReportSheet `context`). */
@Immutable
data class ReportTarget(
    /** The person's ref; a key only, never shown. */
    val ref: String,
    /** Their display name, for "Report {name}". */
    val name: String,
    /** A profile, their spot line, or a meet. */
    val kind: ReportKind,
    /** The person's ref for a profile or a spot line; the meet id for a meet. */
    val id: String,
)

/**
 * Something the People screen should do when it next shows. Each request is new ([id]), so the
 * same request twice is done twice.
 */
@Immutable
data class PeopleRequest(
    /** "Around now" on: `caddie://people?around=1` from a nudge, or the web's `#/people?around=1`. */
    val aroundNow: Boolean = false,
    /** A search to run, with the search bar open (TopicPicker's "Find people who've done this"). */
    val query: String? = null,
    /**
     * A zone from a `#/here/<zone>` link (`AppLink.PeopleRoute.Here`, already percent-decoded):
     * People opens the presence setup with that zone chosen (PresenceControls, validated by
     * `controller.matchZone`). Presence is never turned on by the request alone; the person taps
     * "I'm around".
     */
    val hereZone: String? = null,
    val id: Long = nextRequestId(),
)

private var requestCounter = 0L

private fun nextRequestId(): Long = ++requestCounter

/**
 * The selected conference's talks as the people screens need them: the installed bundle (rooms,
 * topics, talk times), the talks marked Interested and the time, which ticks every 30 seconds.
 */
@Immutable
data class PeopleTalks(
    /** Null while the bundle loads. */
    val bundle: TalkBundle?,
    /** Talk ids marked Interested at the selected conference, oldest first. */
    val interested: List<String>,
    val nowMs: Long,
    /**
     * The People home's For you row (web ForYouRow), drawn by the talk screens
     * (app.conferencecaddie.ui.talks.ForYouRow) because For you is worked out on the device; null
     * leaves the row out (no bundle yet, or a host without the talk screens).
     */
    val forYouRow: (@Composable () -> Unit)? = null,
)

/**
 * The debug launch option `caddie.people` (DebugLaunch.people): a people screen to open once the
 * people features are known, for screenshots: `home`, `around`, `search:<text>`, `profile`,
 * `inbox`, `meet:<id>` or `settings-people` (Settings, whose people groups follow You). The screens
 * a link can name are shown as the link's [AppLink.PeopleRoute] is.
 */
sealed interface PeopleLaunch {
    /** A screen a link can name too. */
    data class Route(val route: AppLink.PeopleRoute) : PeopleLaunch
    data class Search(val text: String) : PeopleLaunch
    data object SettingsPeople : PeopleLaunch

    companion object {
        /** The option [value] names, or null for none or an unknown one. */
        fun parse(value: String?): PeopleLaunch? {
            val v = value?.trim() ?: return null
            return when {
                v.equals("home", ignoreCase = true) -> Route(AppLink.PeopleRoute.Home(aroundNow = false))
                v.equals("around", ignoreCase = true) -> Route(AppLink.PeopleRoute.Home(aroundNow = true))
                v.startsWith("search:", ignoreCase = true) -> v.substring(7).trim().takeIf { it.isNotEmpty() }?.let { Search(it) }
                v.equals("profile", ignoreCase = true) -> Route(AppLink.PeopleRoute.Profile)
                v.equals("inbox", ignoreCase = true) -> Route(AppLink.PeopleRoute.Inbox)
                v.startsWith("meet:", ignoreCase = true) -> v.substring(5).trim().takeIf { it.isNotEmpty() }?.let { Route(AppLink.PeopleRoute.Meet(it)) }
                v.equals("settings-people", ignoreCase = true) -> SettingsPeople
                else -> null
            }
        }
    }
}

/**
 * Whether the composable that remembered it ([rememberInComposition]) is still in the composition.
 * An action that runs on [PeopleHost.scope] reads it when its answer comes, from any thread: an
 * outcome its composable would show itself (an error under a form) goes in a toast instead once the
 * composable has left (scrolled away, or another tab), so it is not lost.
 */
internal class InComposition {
    @kotlin.concurrent.Volatile
    var value: Boolean = false
        internal set
}

/** An [InComposition] that is true from when this composable enters the composition until it leaves. */
@Composable
internal fun rememberInComposition(): InComposition = remember { InComposition() }.also { it.Track() }

/**
 * Makes this [InComposition] true while the call is in the composition, for a composable that
 * remembers it before an early return and is shown only after it.
 */
@Composable
internal fun InComposition.Track() {
    DisposableEffect(this) {
        value = true
        onDispose { value = false }
    }
}

/** The setup panels that are kept in the host's memory ([PeopleHost.rememberPanel]). */
enum class SetupPanel { Presence, BluetoothCard, BluetoothSettings }

/** Whether one card's setup panel is open, read and written through the host's memory; a delegate. */
internal class OpenPanel(private val memory: PeopleHostMemory, private val which: SetupPanel, private val token: String) {
    operator fun getValue(thisRef: Any?, property: KProperty<*>): Boolean = memory.panels[which] == token

    operator fun setValue(thisRef: Any?, property: KProperty<*>, value: Boolean) {
        if (value) {
            memory.panels = memory.panels + (which to token)
        } else if (memory.panels[which] == token) {
            memory.panels = memory.panels - which
        }
    }
}
