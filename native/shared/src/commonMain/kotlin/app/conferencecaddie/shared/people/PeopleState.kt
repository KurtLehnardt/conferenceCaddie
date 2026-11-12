package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.ble.BlePermissionKind
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.core.BundleState
import app.conferencecaddie.shared.core.CapabilitiesState
import app.conferencecaddie.shared.core.ConferencesState
import app.conferencecaddie.shared.core.CoreState

/**
 * What [PeopleController] works from: the backend, what it offers this app, the selected
 * conference and its installed talk bundle, and the Interested list. [fromCore] builds it from
 * [CoreState]; tests build it directly.
 */
data class PeopleContext(
    val backend: BackendUrl.Valid,
    /** The backend's capabilities as this app uses them ([Capabilities.forThisApp]). */
    val capabilities: Capabilities,
    /** The selected conference, or null when none is selected yet. */
    val conference: ConferenceInfo?,
    /** The selected conference's installed talk bundle (rooms for the zones, topics), or null. */
    val bundle: TalkBundle?,
    /** The talks marked Interested at the selected conference, oldest first. */
    val interested: List<String> = emptyList(),
    /**
     * True when this launch keeps the app's data in memory only, because the stored database could
     * not be opened ([CoreState.storageInMemory]). The people records have a file of their own
     * ([PeopleDatabase]), but a launch whose main database failed is treated as one whose records
     * may not last either, so the controller creates nothing on the server that this phone could
     * lose track of. The device credential is in the secure store and is not affected.
     */
    val storageInMemory: Boolean = false,
    /**
     * Every conference the backend's list names, the selected one included, or empty while the list
     * is not known. "Delete my profile" reaches the ones still live ([ConferenceWindow]) even when the
     * device's records were lost, and the Android background check reads the selected one's dates.
     */
    val listed: List<ConferenceInfo> = emptyList(),
    /**
     * True when [listed] is the backend's list as read, even when that list is empty, and false
     * while it is not known (not loaded yet, or it failed). A backend that lists no conference is a
     * known answer: "Delete my profile" then has no other conference to reach. [fromCore] sets it
     * from the core's conference state; a context built by hand counts a list it was given as known.
     */
    val listKnown: Boolean = listed.isNotEmpty(),
) {
    companion object {
        /**
         * The context [state] describes, or null while the capabilities are still loading. A backend
         * that cannot be reached with nothing cached, or that needs a newer app, offers no people
         * features. The conference comes from the installed bundle, or from the conference list
         * while the bundle loads.
         */
        fun fromCore(state: CoreState): PeopleContext? {
            val caps = when (val c = state.capabilities) {
                is CapabilitiesState.Ready -> c.forThisApp
                CapabilitiesState.Loading -> return null
                else -> Capabilities.None
            }
            val bundle = (state.bundle as? BundleState.Ready)?.bundle?.takeIf { it.conference.slug == state.selectedSlug }
            val all = (state.conferences as? ConferencesState.Ready)?.conferences.orEmpty().map { it.conference }
            val listed = all.firstOrNull { it.slug == state.selectedSlug }
            val conference = (bundle?.conference ?: listed)?.let {
                ConferenceInfo(it.slug, it.name, it.timeZone, it.startDate, it.endDate, it.demo)
            }
            return PeopleContext(
                state.backend,
                caps,
                conference,
                bundle,
                if (conference != null) state.interested else emptyList(),
                storageInMemory = state.storageInMemory,
                listed = all.map { ConferenceInfo(it.slug, it.name, it.timeZone, it.startDate, it.endDate, it.demo) },
                listKnown = state.conferences is ConferencesState.Ready,
            )
        }
    }
}

/** The selected conference, as the people features need it. */
data class ConferenceInfo(
    val slug: String,
    val name: String,
    val timeZone: String? = null,
    /** `YYYY-MM-DD`, or null. */
    val startDate: String? = null,
    val endDate: String? = null,
    /** A demo conference (`"demo": true`), whose notifications this device marks as such ([app.conferencecaddie.shared.Demo]). */
    val demo: Boolean = false,
)

/** Which people features the backend offers this app, from `forThisApp()`. */
data class PeopleFeatures(
    /** People features at all (`people.enabled`); without it nothing else is offered. */
    val enabled: Boolean = false,
    /** "I'm around", Who's around and nudges (`people.presence`). */
    val presence: Boolean = false,
    /** "Use my position too" (`people.gps_bands`). */
    val gpsBands: Boolean = false,
    /** Ask to talk shop, the inbox and meets (`people.meets`). */
    val meets: Boolean = false,
    /** Talk circles (`people.circles`). */
    val circles: Boolean = false,
    /** Report (`people.reports`); always on when [enabled]. */
    val reports: Boolean = false,
    /**
     * The native push channel this build and backend share ("apns" or "fcm"), or null: then nudges
     * are in-app and local notifications only.
     */
    val pushChannel: String? = null,
    /** The Bluetooth mode this app uses: [Capabilities.BleMode.DerivedV1] or [Capabilities.BleMode.None]. */
    val bleMode: Capabilities.BleMode = Capabilities.BleMode.None,
) {
    companion object {
        val OFF = PeopleFeatures()
    }
}

/** Whether the people screens have anything to show. */
enum class PeopleAvailability {
    /**
     * The backend's capabilities are not known yet, or the people records of this backend could not
     * be read yet (the controller tries again on the next change, the next action and on a timer).
     */
    Loading,

    /** The backend offers no people features: the People tab is hidden. */
    Off,

    /** People features are on, but no conference is selected. */
    NoConference,

    Ready,
}

/** The meet inbox of the selected conference. */
data class InboxView(
    /** Open asks to me, newest first, without blocked people. */
    val incoming: List<MeetView> = emptyList(),
    /** My open asks, newest first, without blocked people. */
    val outgoing: List<MeetView> = emptyList(),
    /** True once the inbox has been read at least once. */
    val loaded: Boolean = false,
    /** Incoming asks waiting for an answer: the People tab's badge. */
    val count: Int = 0,
    /** My open asks by the person's ref ("No reply yet" on their card), including ones sent since the last poll. */
    val askStates: Map<String, MeetState> = emptyMap(),
)

/** Unfinished profile deletes of this backend. */
data class DeletesView(
    /** True while any delete is unfinished: "Delete my profile", or the server copy at some conference. */
    val unfinished: Boolean = false,
    /** True while "Delete my profile" is unfinished. */
    val deleteAll: Boolean = false,
    /** True while a delete covers the selected conference, so nothing is shared there. */
    val coversConference: Boolean = false,
    /**
     * The conferences whose server copy is still being removed (not "Delete my profile" itself), for
     * "Removing your profile from {n} conferences has not finished."
     */
    val pendingSlugs: List<String> = emptyList(),
    /** Why the last attempt failed, in plain words, or null. */
    val detail: String? = null,
    /** Why the user may stop trying, or null while they may not yet. */
    val stopTryingReason: StopTryingReason? = null,
)

/** Native push nudges at the selected conference. */
data class PushView(
    /** True when this build can receive the backend's native push ([PeopleFeatures.pushChannel]). */
    val available: Boolean = false,
    /** True while the backend holds this device's token for the conference. */
    val on: Boolean = false,
    val noticeSeen: Boolean = false,
)

/** Why Bluetooth proximity is off, or could not start, shown under its switch. */
enum class BleProblem {
    /** Presence is off at this conference: "Turn on being around first." */
    NeedsPresence,

    /** The Bluetooth permission was refused; asking again still shows the prompt. */
    PermissionDenied,

    /** The Bluetooth permission was refused for good: only the system settings can allow it. */
    PermissionBlocked,

    /** Bluetooth is switched off on the device. */
    BluetoothOff,

    /** Android 8 to 11: the Location switch is off, which a Bluetooth scan needs there. */
    LocationOff,

    /** This phone's Bluetooth cannot send the code. */
    Unsupported,

    /** It stopped because the same profile turned it on on another device (a second re-key in one window). */
    OtherDevice,

    /** The presence write or the radio failed; [BleView.message] has the words. */
    Failed,
}

/**
 * Bluetooth proximity ("Find people near me by Bluetooth") at the selected conference
 * (web/src/people/BleControls.tsx and ble.ts).
 */
data class BleView(
    /**
     * True when the row shows: the backend resolves derived-v1 tokens, presence is a feature there,
     * and this device has a radio that can take part.
     */
    val available: Boolean = false,
    /** True while it runs at this conference (the device's switch). */
    val on: Boolean = false,
    /** True while a turn-on is under way (permission prompts, the presence write, the radio start). */
    val starting: Boolean = false,
    /** True once the first-time explanation has been accepted at this conference. */
    val noticeSeen: Boolean = false,
    /** The permission this platform asks for, so the explanation names the right one. */
    val permission: BlePermissionKind = BlePermissionKind.NearbyDevices,
    /** Why it is off or could not start, or null. Cleared by the next turn-on. */
    val problem: BleProblem? = null,
    /** The words for [problem] when the screens have none of their own ([BleProblem.Failed]). */
    val message: String? = null,
    /** False when notifications are not allowed, so a nearby match cannot be announced. */
    val notificationsAllowed: Boolean = true,
    /** True when iPhones may not find this phone (Android 13 and older; [app.conferencecaddie.shared.ble.BleRadio.hiddenFromIphones]). */
    val hiddenFromIphones: Boolean = false,
)

/** What [PeopleController.turnOnBluetooth] ended with. */
sealed interface BleOutcome {
    data object On : BleOutcome

    data class Problem(val problem: BleProblem, val message: String? = null) : BleOutcome
}

/** The first page of "Who's around", refreshed while the Around view is showing. */
data class AroundView(
    val visible: Boolean = false,
    val loading: Boolean = false,
    /** In the server's order, without blocked people. Split by zone only through [PeoplePrivacy]. */
    val people: List<Person> = emptyList(),
    /** True once a page has arrived. */
    val loaded: Boolean = false,
    /** True when the server has more people after this page (`has_more`): the list pages on from [people]'s size. */
    val hasMore: Boolean = false,
    val error: PeopleError? = null,
)

/**
 * Everything the people screens show for the selected conference, in one immutable value. The
 * controller publishes a new one after every change.
 */
data class PeopleUiState(
    val availability: PeopleAvailability = PeopleAvailability.Loading,
    /** The normalised base of the current backend. */
    val backend: String? = null,
    val conference: ConferenceInfo? = null,
    val features: PeopleFeatures = PeopleFeatures.OFF,
    /**
     * True while the backend offers people features but its records could not be opened on the last
     * try; the controller tries again on a timer, on the next action and on `retrySession`.
     */
    val sessionFailed: Boolean = false,
    /** True once this device has a credential for the backend (after the first visible write). */
    val hasDevice: Boolean = false,
    /** The profile on this device, or [Profile.EMPTY]. */
    val profile: Profile = Profile.EMPTY,
    /** The topics chosen for the selected conference. */
    val topics: ConferenceTopics = ConferenceTopics(),
    val visibility: Visibility = Visibility(),
    val sync: SyncStatus = SyncStatus.IDLE,
    /** Increases after every successful profile write, so screens can fetch server results again. */
    val saveCount: Int = 0,
    val deletes: DeletesView = DeletesView(),
    /** Presence at the selected conference as it stands now (off once its `until` has passed). */
    val presence: Presence = Presence(),
    /** The conference's zones: its rooms, then the fixed zones. */
    val zones: List<String> = PeopleZones.FIXED,
    /** The chips beside "Yes" in "Still in {zone}?", most likely first. */
    val likelyZones: List<String> = emptyList(),
    /** The zone last chosen, for the picker's default. */
    val lastZone: String? = null,
    /** What the platform allows for the device's position. */
    val locationAccess: LocationAccess = LocationAccess.Unavailable,
    val inbox: InboxView = InboxView(),
    /** The nudge banner to show, or null. */
    val nudge: Nudge? = null,
    val nudgesOn: Boolean = true,
    /** The ref whose card "See who" should land on, or null; call [PeopleController.consumeReveal] once handled. */
    val reveal: String? = null,
    val watch: List<Watch> = emptyList(),
    val blocks: List<BlockedPerson> = emptyList(),
    val met: List<MetPerson> = emptyList(),
    val push: PushView = PushView(),
    /** Bluetooth proximity at the selected conference. */
    val ble: BleView = BleView(),
    val around: AroundView = AroundView(),
    /** A message from work the controller did on its own (an automatic share), for a toast; clear with [PeopleController.clearNotice]. */
    val notice: PeopleNotice? = null,
)

/**
 * A toast from work the controller did on its own, such as the automatic share of "sharing follows
 * Interested". The controller decides whether the toast offers "Open profile", so no screen has to
 * read the wording.
 */
data class PeopleNotice(
    val message: String,
    /** True when the fix is on the profile screen: the toast offers "Open profile" (web/src/app.tsx). */
    val opensProfile: Boolean,
)
