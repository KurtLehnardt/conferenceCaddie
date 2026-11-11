package app.conferencecaddie.ui.people

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.setValue
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.people.Person
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.ReportKind
import app.conferencecaddie.ui.shell.PeoplePage
import app.conferencecaddie.ui.shell.ShellNavigator
import app.conferencecaddie.ui.shell.Tab
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * What every people screen gets besides the state: the [controller] and the app around it. Screens
 * take it as a parameter, next to the `PeopleUiState` they draw, and never reach for the app in any
 * other way:
 *
 * - [controller]: the people features. Its actions are suspend functions; call them from a
 *   `rememberCoroutineScope()` of the screen.
 * - Moving around: [openProfile], [openInbox], [openMeet], [openPeople], [openSettings] and [back].
 * - The shell's one toast: [showToast].
 * - The sheets and the dialog that more than one screen opens, drawn once by the People layer:
 *   [ask] (AskSheet), [report] (ReportSheet) and [confirmBlock] (the block confirmation, then the
 *   block, its toast and Undo).
 * - Talks and links: [openTalk] opens the talk sheet; [openUrl] opens an http(s) link.
 * - What this run remembers across screens: [hasWaved] and [markWaved] ("Waved" on a card).
 * - The platform: [nowMs] (the controller's clock, so a test's clock reaches the screens too) and
 *   [openAppSettings] (this app's page in the system settings, where [canOpenAppSettings]).
 *
 * One instance lives as long as the app's composition; it holds no data of its own beyond the
 * state of the sheets, the pending [request] and the refs waved at.
 */
@Stable
class PeopleHost(
    val controller: PeopleController,
    private val navigator: ShellNavigator,
    /**
     * A scope that lives as long as the app's composition, for work that must finish after a screen
     * leaves (`controller.setInboxVisible(false)` from a DisposableEffect). Everything else uses
     * the screen's own `rememberCoroutineScope()`.
     */
    val scope: CoroutineScope,
    private val toast: (message: String, action: PeopleToastAction?) -> Unit,
    /** Opens the talk with this id in the talk sheet. */
    val openTalk: (talkId: String) -> Unit,
    /** Opens an http(s) link in the browser; nothing else is opened. */
    val openUrl: (url: String) -> Unit,
) {
    // ---------------------------------------------------------------------------------------------
    // Moving around

    /** Profile (#/profile), from "Create my profile" or "Open my profile". */
    fun openProfile() = navigator.openPage(PeoplePage.Profile)

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
        if (request != null) this.request = request
        navigator.selectTab(Tab.People)
    }

    /** Leaves the page showing, as the system Back does. */
    fun back() = navigator.back()

    /** What the People screen should do when it next shows, or null; see [requestHandled]. */
    var request: PeopleRequest? by mutableStateOf(null)
        private set

    /** The People screen did what [handled] asked; a newer request stays. */
    fun requestHandled(handled: PeopleRequest) {
        if (request == handled) request = null
    }

    // ---------------------------------------------------------------------------------------------
    // Toasts

    /** Shows [message] in the shell's toast, with an optional action such as Undo. */
    fun showToast(message: String, action: PeopleToastAction? = null) = toast(message, action)

    // ---------------------------------------------------------------------------------------------
    // Sheets and dialogs that more than one screen opens

    /** The person "Ask to talk shop" is open for, or null. */
    var asking: Person? by mutableStateOf(null)
        private set

    /** Opens AskSheet for [person]. */
    fun ask(person: Person) {
        asking = person
    }

    fun closeAsk() {
        asking = null
    }

    /** What ReportSheet is open for, or null. */
    var reporting: ReportTarget? by mutableStateOf(null)
        private set

    /** Opens ReportSheet for [target]. */
    fun report(target: ReportTarget) {
        reporting = target
    }

    fun closeReport() {
        reporting = null
    }

    /** The person the block confirmation is open for, or null. */
    var blocking: BlockTarget? by mutableStateOf(null)
        private set

    /**
     * Blocks [name] (connect.ts blockWithConfirm): asks first ("Block {name}?"), then blocks, which
     * drops them from every list at once, and toasts "Blocked {name}" with Undo; a refusal brings
     * them back and toasts the web's message. [after] runs once the person confirmed, before the
     * server answers, for a screen that drops a card of its own (an incoming ask).
     */
    fun confirmBlock(ref: String, name: String, after: () -> Unit = {}) {
        blocking = BlockTarget(ref, name, after)
    }

    fun closeBlock() {
        blocking = null
    }

    /** The confirmation's Block: runs the block of [target]. */
    internal fun block(target: BlockTarget) {
        blocking = null
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

    private var waved: Set<String> by mutableStateOf(emptySet())

    /** True when this run waved at [ref], so their card says "Waved" rather than "No reply yet". */
    fun hasWaved(ref: String): Boolean = ref in waved

    fun markWaved(ref: String) {
        waved = waved + ref
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
    /** "Around now" on: `caddie://people?around=1` from a nudge (the web's `#/people?around=1`). */
    val aroundNow: Boolean = false,
    /** A search to run, with the search bar open (TopicPicker's "Find people who've done this"). */
    val query: String? = null,
    /** A zone from `caddie://here/{zone}`: presence on in it (PresenceControls). Not routed yet. */
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
)

/**
 * A deep link from a tapped notification (NotificationTaps): the links the app writes are
 * `caddie://people?around=1`, `caddie://inbox` and `caddie://meet/{meet_id}`. Anything else is
 * ignored.
 */
sealed interface PeopleLink {
    /** The People tab, with "Around now" on when [aroundNow]. */
    data class People(val aroundNow: Boolean) : PeopleLink

    /** Requests. */
    data object Inbox : PeopleLink

    /** Meet up for [meetId]. */
    data class Meet(val meetId: String) : PeopleLink

    companion object {
        private val MEET_ID = Regex("[A-Za-z0-9_-]{1,128}")

        /** The screen [link] names, or null for anything the app does not write. */
        fun parse(link: String): PeopleLink? {
            val rest = link.trim().let { if (it.startsWith("caddie://", ignoreCase = true)) it.substring(9) else return null }
            val path = rest.substringBefore('?').substringBefore('#').trimEnd('/')
            val query = rest.substringAfter('?', "").substringBefore('#')
            return when {
                path.equals("people", ignoreCase = true) -> People(aroundNow = query.split('&').any { it == "around=1" })
                path.equals("inbox", ignoreCase = true) -> Inbox
                path.startsWith("meet/", ignoreCase = true) -> path.substring(5).takeIf { MEET_ID.matches(it) }?.let { Meet(it) }
                else -> null
            }
        }
    }
}

/**
 * The debug launch option `caddie.people` (DebugLaunch.people): a people screen to open once the
 * people features are known, for screenshots: `home`, `around`, `search:<text>`, `profile`,
 * `inbox`, `meet:<id>` or `settings-people` (Settings, whose people groups follow You).
 */
sealed interface PeopleLaunch {
    data object Home : PeopleLaunch
    data object Around : PeopleLaunch
    data class Search(val text: String) : PeopleLaunch
    data object Profile : PeopleLaunch
    data object Inbox : PeopleLaunch
    data class Meet(val meetId: String) : PeopleLaunch
    data object SettingsPeople : PeopleLaunch

    companion object {
        /** The option [value] names, or null for none or an unknown one. */
        fun parse(value: String?): PeopleLaunch? {
            val v = value?.trim() ?: return null
            return when {
                v.equals("home", ignoreCase = true) -> Home
                v.equals("around", ignoreCase = true) -> Around
                v.startsWith("search:", ignoreCase = true) -> v.substring(7).trim().takeIf { it.isNotEmpty() }?.let { Search(it) }
                v.equals("profile", ignoreCase = true) -> Profile
                v.equals("inbox", ignoreCase = true) -> Inbox
                v.startsWith("meet:", ignoreCase = true) -> v.substring(5).trim().takeIf { it.isNotEmpty() }?.let { Meet(it) }
                v.equals("settings-people", ignoreCase = true) -> SettingsPeople
                else -> null
            }
        }
    }
}
