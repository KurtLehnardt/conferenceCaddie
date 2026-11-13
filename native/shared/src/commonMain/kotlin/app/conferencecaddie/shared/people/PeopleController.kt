package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.LocationProvider
import app.conferencecaddie.shared.Notifier
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.PushToken
import app.conferencecaddie.shared.SystemSettings
import app.conferencecaddie.shared.ble.BleHost
import app.conferencecaddie.shared.ble.BleRuntime
import app.conferencecaddie.shared.core.CoreState
import app.conferencecaddie.shared.net.ApiHttp
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.ContinuationInterceptor
import kotlin.coroutines.CoroutineContext
import kotlin.math.max
import kotlin.math.min
import kotlin.time.Clock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.datetime.TimeZone

/** What [PeopleController.enablePush] ended with. */
sealed interface PushOutcome {
    /** The backend now holds this device's token for the conference. */
    data object On : PushOutcome

    /** This build and backend share no native push channel; nudges stay in-app and local. */
    data object Unavailable : PushOutcome

    /** Notifications were refused, or the platform gave no token. */
    data object Denied : PushOutcome

    /** Push needs a visible profile at this conference first. */
    data object ProfileNeeded : PushOutcome

    /** A delete covers the conference, so nothing is registered. */
    data object DeleteUnfinished : PushOutcome

    data class Failed(val error: PeopleError) : PushOutcome
}

/** What [PeopleController.toggleWatch] ended with. */
sealed interface WatchOutcome {
    /** The person is watched now ([on]), or not any more. */
    data class Done(val on: Boolean) : WatchOutcome

    /** Nothing changed; [message] is the web's line for it, as an action that returns a message gives it. */
    data class Failed(val message: String) : WatchOutcome
}

/**
 * The people features of the native apps in one place: profile and visibility sync, deletes,
 * presence, asks and meets, the inbox, nudges, the watch list, blocks, reports, circles, push and
 * Bluetooth proximity, ported from web/src/people and talking People API v1 ([PeopleApi]).
 *
 * Feed it the current backend, its capabilities, the selected conference and its installed bundle,
 * either with [bind] (from [CoreState]) or with [updateContext], and tell it when the app goes to
 * the background and back with [setForeground]. Render [state]; call the actions below. Every action
 * is a suspend function that is safe to call from any thread; actions that return a `String?`
 * return the web app's message for a failure (null on success), and actions that return an
 * [ApiResult] leave the wording to the screen, which maps [PeopleError.kind] (or shows
 * [PeopleError.message], the web's generic line). No action throws: a failure the controller does
 * not expect (its records could not be written, say) comes back as the action's failure value.
 *
 * An action that changes something runs to its end on the controller's own scope even when its
 * caller is cancelled (the screen that asked has gone), so what the device records always follows
 * the server's answer; cancelling the caller only stops the waiting. Reads (searches, a meet, circle
 * members and counts) stop with their caller.
 *
 * Everything runs on one serial view of [scope]'s dispatcher, so the controller's state changes as
 * in the web app's single thread. Timers use [clock] and the coroutine scheduler, so tests run on
 * virtual time. Nothing here logs, and work the controller starts on its own that fails (a timer, a
 * poll, a retry) ends quietly rather than ending the app.
 *
 * Construct one per process with [create] and keep it as long as the [CaddieCore] it is bound to.
 * [allowLocalHttp] is true in debug builds only; otherwise a backend that is not https gets no
 * people features.
 */
class PeopleController(
    private val keyValue: PeopleKeyValue,
    private val http: ApiHttp,
    private val services: PeopleServices,
    scope: CoroutineScope,
    private val allowLocalHttp: Boolean,
    /** Where the controller reads the time; the screens read "now" from it too, so tests agree with it. */
    val clock: Clock = Clock.System,
    private val timeZone: TimeZone = TimeZone.currentSystemDefault(),
) {
    @OptIn(ExperimentalCoroutinesApi::class)
    private val serial: CoroutineDispatcher =
        ((scope.coroutineContext[ContinuationInterceptor] as? CoroutineDispatcher) ?: Dispatchers.Default).limitedParallelism(1)

    // Work the controller starts on its own that fails ends there: the exception reaches neither
    // the app's thread nor a log, since its message can carry people data.
    private val quiet = CoroutineExceptionHandler { _, _ -> }
    private val scope = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]) + serial + quiet + Owner(this))

    private val _state = MutableStateFlow(PeopleUiState())

    /** Everything the people screens show for the selected conference. */
    val state: StateFlow<PeopleUiState> = _state.asStateFlow()

    /** Opens this app's page in the system settings ([PeopleServices.systemSettings]), or null where the platform has none. */
    val systemSettings: SystemSettings? get() = services.systemSettings

    /**
     * Test hook, which does nothing in the app. It runs at the end of every action a screen calls
     * (each write, as [write] runs it), after the action has published what it changed and before
     * its caller hears back. A UI test sets it to hold an action at that moment, when the screens
     * already show the outcome (a row the answer removes is gone) and the caller is still waiting.
     */
    @PeopleTestHook
    @kotlin.concurrent.Volatile
    var beforeActionReturns: suspend () -> Unit = {}

    private var context: PeopleContext? = null
    @kotlin.concurrent.Volatile
    private var session: Session? = null

    // One session per backend base for the life of the controller. Coming back to a backend takes
    // up its session again, so its records have one copy in memory and its writes and deletes keep
    // one write lock, whatever was still under way when the backend was left.
    private val sessions = HashMap<String, Session>()
    private var sessionRetry: Job? = null

    // Applying a context waits for the one before it to finish, so a session whose records are still
    // being read is never opened twice (the core's next context, and an action or the retry that opens
    // a session that could not be read before, can arrive while the read is under way).
    private val contextLock = Mutex()
    private var foreground = true
    private var bindJob: Job? = null
    private var lastInterested: Pair<String, Set<String>>? = null
    private var notice: PeopleNotice? = null
    private var aroundVisible = false
    // Requests is showing. Remembered when it opens before the controller is ready, and applied then.
    private var inboxVisible = false
    private var around = AroundView()
    private var aroundJob: Job? = null
    private var aroundGeneration = 0
    private val countCache = HashMap<String, CountEntry>()
    private val countBatches = ArrayList<CountBatch>()
    private val pushUnavailable = HashSet<String>()
    private val renewedPush = HashSet<String>()
    private var zonesKey: String? = null
    private var zones: List<String> = PeopleZones.FIXED

    // ---------------------------------------------------------------------------------------------
    // Lifecycle

    /** Follows [core]: its backend, capabilities, selected conference, bundle and Interested list. */
    fun bind(core: StateFlow<CoreState>) {
        bindJob?.cancel()
        bindJob = scope.launch {
            // A context that cannot be applied (the records could not be read) ends neither the
            // collection nor the app: the next context, or a later attempt, tries again.
            core.map { PeopleContext.fromCore(it) }.distinctUntilChanged().collect { applyGuarded(it) }
        }
    }

    /** Sets the context directly (tests, previews, or a host without [CaddieCore]); null while it is not known. */
    suspend fun updateContext(next: PeopleContext?): Unit = withContext(serial) { applyGuarded(next) }

    /**
     * The app went to the background (false) or came back (true). In the background, hour-mode
     * presence ends after five minutes (not while Bluetooth proximity runs at that conference),
     * positions stop and nothing is polled; back in the foreground, an old zone is asked about,
     * unfinished deletes are tried again and the inbox is read.
     */
    fun setForeground(foreground: Boolean) {
        scope.launch {
            quietly {
                openSession()
                applyForeground(foreground)
            }
        }
    }

    /**
     * One nudge check for the selected conference, for a platform's background task: a strong match
     * in my zone shows as a local notification with the web's exact words, which never name anyone.
     */
    suspend fun backgroundCheck(): Unit = read(Unit) {
        val r = ready() ?: return@read
        if (r.features.presence) r.s.connect.nudgeTick(r.slug, notify = true)
    }

    /** Clears [PeopleUiState.notice] once the screen has shown it. */
    suspend fun clearNotice(): Unit = write(Unit) {
        notice = null
        publish()
    }

    /** Stops every timer and poll. The controller cannot be used afterwards. */
    fun close() {
        scope.cancel()
    }

    // ---------------------------------------------------------------------------------------------
    // Profile and visibility

    /**
     * Changes the profile on the device and, after a one-second pause, sends it to every conference
     * that holds it (the selected one first). Fields are cut to the server's caps. Returns null once
     * the change is on the device, or the web's message when it is not: the records are not open
     * (still loading, or they could not be read or written) or this server offers no people features.
     */
    suspend fun updateProfile(transform: (Profile) -> Profile): String? = write(FAILED_MESSAGE) { editProfile(transform) }

    private suspend fun editProfile(transform: (Profile) -> Profile): String? {
        val s = enabledSession() ?: return noSessionMessage()
        s.store.setProfile(transform(s.store.profile ?: Profile.EMPTY).sanitized())
        s.sync.scheduleProfileSync(context?.conference?.slug)
        publish()
        return null
    }

    /**
     * Sets the selected conference's learn and speak topics (at most 30 each) and saves the profile.
     * Returns null once they are on the device, or the message as [updateProfile] does. Topics picked
     * for [conference] (a slug) are refused once another conference is selected, so one
     * conference's topics never land on another's; without a selected conference there is nothing
     * to set them for. Either way the message says they were not saved.
     */
    suspend fun setTopics(learn: List<TopicRef>, speak: List<TopicRef>, conference: String? = null): String? = write(FAILED_MESSAGE) {
        val slug = context?.conference?.slug?.takeIf { conference == null || it == conference } ?: return@write FAILED_MESSAGE
        editProfile { it.copy(topics = it.topics + (slug to ConferenceTopics(learn.take(30), speak.take(30)))) }
    }

    /**
     * Turns conference-wide visibility on or off. Off with no shared talks removes the profile from
     * the server. Returns the web's message for a failure, or null.
     */
    suspend fun setOpenToMeet(on: Boolean): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write PeopleError.NOT_OFFERED_MESSAGE
        r.s.sync.changeVisibility(r.slug, { it.copy(openToMeet = on) }).also {
            refreshDevice(r.s)
            publish()
        }
    }

    /** Shares the profile for [talkId], or stops. Returns an error or hint message ([isHintMessage]), or null. */
    suspend fun shareForTalk(talkId: String, on: Boolean): String? = if (on) shareForTalks(listOf(talkId)) else unshareTalks(listOf(talkId))

    /** Shares for every talk in [talkIds] (keeping existing shares), up to 50. Returns an error or hint message, or null. */
    suspend fun shareForTalks(talkIds: List<String>): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write PeopleError.NOT_OFFERED_MESSAGE
        invalidateCounts(r.slug, talkIds)
        r.s.sync.shareForTalks(r.slug, talkIds).also {
            refreshDevice(r.s)
            publish()
        }
    }

    /** Stops sharing for [talkIds]. Returns an error message, or null. */
    suspend fun unshareTalks(talkIds: List<String>): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write PeopleError.NOT_OFFERED_MESSAGE
        invalidateCounts(r.slug, talkIds)
        r.s.sync.unshareTalks(r.slug, talkIds).also { publish() }
    }

    /** "Stop sharing for all" at the selected conference. Conference-wide visibility is unchanged. */
    suspend fun unshareAll(): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write PeopleError.NOT_OFFERED_MESSAGE
        invalidateCounts(r.slug, r.s.store.visibility(r.slug).sharedTalkIds)
        r.s.sync.unshareAll(r.slug).also { publish() }
    }

    /**
     * Turns on "sharing follows Interested" and shares for every talk already marked; the switch
     * stays off when that share fails, and the message says why.
     */
    suspend fun followInterested(): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write PeopleError.NOT_OFFERED_MESSAGE
        r.s.sync.followInterested(r.slug, r.ctx.interested).also {
            refreshDevice(r.s)
            publish()
        }
    }

    /** Turns "sharing follows Interested" off; the shares made so far stay. Returns the message for a failure, or null. */
    suspend fun stopFollowingInterested(): String? = editVisibility { it.copy(shareNew = false) }

    /** The sharing notice was shown. Returns the message for a failure, or null. */
    suspend fun markShareNoticeSeen(): String? = editVisibility { it.copy(shareNoticeSeen = true) }

    /** The ended-talk banner of [talkId] was seen or closed. Returns the message for a failure, or null. */
    suspend fun markBannerSeen(talkId: String): String? = editVisibility { it.copy(bannerSeen = (it.bannerSeen + talkId).takeLast(200)) }

    // A change of the device's own choices: kept only once stored. Records that are not open or
    // cannot be written leave the choice as it was and return the web's message, as
    // [updateProfile] does.
    private suspend fun editVisibility(transform: (Visibility) -> Visibility): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write noSessionMessage()
        r.s.store.setVisibility(r.slug, undoOnFailure = true, transform)
        publish()
        null
    }

    // ---------------------------------------------------------------------------------------------
    // Deletes

    /**
     * "Delete my profile": deletes the profile on the server at every conference of this backend,
     * then this device's people data and credential ("People I met" stays). Unfinished deletes are
     * tried again by themselves; until they finish, nothing is shared.
     */
    suspend fun deleteMyProfile(): DeleteResult = write(DeleteResult(false, PeopleError.UNAVAILABLE_MESSAGE)) {
        val s = session ?: return@write DeleteResult(false, PeopleError.NOT_OFFERED_MESSAGE)
        s.sync.deleteMyProfile().also {
            refreshDevice(s)
            publish()
        }
    }

    /**
     * Takes over, once, what an earlier app on this phone kept for [backend] ([LegacyPeople]): its
     * device [credential] (`{profile_id}.{secret}`), so the profile it made on the server stays this
     * phone's to change and delete, and its [profile], so nothing is typed again. A credential this
     * app already holds is kept ([DeviceCredentials.adopt]), and so is a profile it already holds or
     * an unfinished "Delete my profile". Returns true when the hand-over is settled (stored, kept, or
     * refused as malformed) and false when the secure store or the records could not be used now, so
     * the caller tries again at a later start. The backend's session, when it is open, sees the
     * credential at once, so a visible write made after this never generates a second one.
     */
    suspend fun adoptLegacy(backend: BackendUrl.Valid, credential: String?, profile: Profile?): Boolean = write(false) {
        contextLock.withLock {
            val s = sessions[backend.base]
            if (credential != null) (s?.credentials ?: DeviceCredentials(services.secureStore, backend)).adopt(credential)
            if (profile != null) {
                val store = s?.store ?: PeopleStore(keyValue, backend.base)
                store.load()
                if (store.profile == null && store.deleteAll == null) store.setProfile(profile.sanitized())
            }
            if (s != null && session === s) {
                refreshDevice(s)
                publish()
            }
            true
        }
    }

    /** "Try again" on an unfinished delete. True when nothing is left unfinished. */
    suspend fun finishPendingDeletes(): Boolean = write(false) {
        val s = session ?: return@write false
        s.sync.finishPendingDeletes().also {
            refreshDevice(s)
            publish()
        }
    }

    /**
     * "Stop trying", offered once [DeletesView.stopTryingReason] is set. Returns the message after
     * "Delete my profile", else null; a failure on the device returns the web's generic line.
     */
    suspend fun stopTrying(): String? = write(PeopleError.UNAVAILABLE_MESSAGE) {
        val s = session ?: return@write null
        s.sync.stopTrying().also {
            refreshDevice(s)
            publish()
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Presence

    /**
     * Turns presence on in [zone] with the spot line [spot] (cut to 60 characters) for an hour or the
     * day ([mode], by default the last one used), or moves it. Returns the web's message for a
     * failure, or null.
     */
    suspend fun turnOnPresence(zone: String, spot: String, mode: PresenceMode? = null): String? = write(FAILED_MESSAGE) {
        val r = ready()?.takeIf { it.features.presence } ?: return@write PeopleError.NOT_OFFERED_MESSAGE
        // A write without `ble` leaves Bluetooth as it is on the server; a new until reaches the
        // radio through PresenceHost.presenceChanged.
        r.s.presenceRuntime.turnOn(r.slug, zone, spot, mode ?: r.s.presenceRuntime.get(r.slug).mode).also { publish() }
    }

    /** "Extend": keeps the zone and spot and starts a fresh hour (or renews the day). */
    suspend fun extendPresence(): String? = write(FAILED_MESSAGE) {
        val r = ready()?.takeIf { it.features.presence } ?: return@write PeopleError.NOT_OFFERED_MESSAGE
        r.s.presenceRuntime.extend(r.slug).also { publish() }
    }

    /**
     * Turns presence off at once on the device, then on the server. Returns the web's message when
     * the device could not record it: then nothing changed, here or on the server, and presence
     * stays on (it still ends by itself at its `until`).
     */
    suspend fun turnOffPresence(): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write noSessionMessage()
        r.s.presenceRuntime.turnOff(r.slug, undoOnFailure = true)
        publish()
        null
    }

    // ---------------------------------------------------------------------------------------------
    // Bluetooth proximity (phase 4)

    /**
     * "Find people near me by Bluetooth" on at the selected conference (web ble.ts startBle): needs
     * presence on, a derived-v1 backend and a radio ([PeopleUiState.ble] `available`). Asks for the
     * Bluetooth permission and for notifications, writes presence again with `ble: true` (repeating
     * the zone, spot, position and duration), keeps the key in the platform key store and starts the
     * radio. [PeopleUiState.ble] follows every step (`starting` while it runs); a problem stays under
     * the switch until the next turn-on. Turning it on at one conference stops it at any other.
     * Show [PeopleText.BLE_NOTICE] first while [BleView.noticeSeen] is false.
     */
    suspend fun turnOnBluetooth(): BleOutcome = write(BleOutcome.Problem(BleProblem.Failed, PeopleText.BLE_START_FAILED)) {
        val r = ready()?.takeIf { it.features.presence } ?: return@write BleOutcome.Problem(BleProblem.Unsupported, PeopleText.BLE_UNSUPPORTED)
        r.s.ble.turnOn(r.slug).also { publish() }
    }

    /**
     * Turns Bluetooth proximity off at the selected conference and tells the server (`ble: false`);
     * presence stays. Returns the web's message when the device could not record it: then Bluetooth
     * runs on as before and nothing is sent.
     */
    suspend fun turnOffBluetooth(): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write noSessionMessage()
        r.s.ble.turnOff(r.slug, undoOnFailure = true)
        publish()
        null
    }

    /** "Still in {zone}?" answered with [zone] (the same one, or a new one). */
    suspend fun confirmZone(zone: String): String? = write(FAILED_MESSAGE) {
        val r = ready()?.takeIf { it.features.presence } ?: return@write PeopleError.NOT_OFFERED_MESSAGE
        r.s.presenceRuntime.confirmZone(r.slug, zone).also { publish() }
    }

    /**
     * The "Still in" row closed without an answer: that counts as yes until the next threshold.
     * Returns the message for a failure (the row stays), or null.
     */
    suspend fun dismissZoneCheck(): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write noSessionMessage()
        r.s.presenceRuntime.dismissZoneCheck(r.slug)
        publish()
        null
    }

    /**
     * "Use my position too": on asks for location access if it was never asked (show
     * [PeopleText.POSITION_EXPLAINER] first); off clears the position on the server at once. A
     * choice the device could not store is [PositionOutcome.NotSaved], and nothing changed.
     */
    suspend fun sharePosition(on: Boolean): PositionOutcome = write(PositionOutcome.NotSaved) {
        val r = ready()?.takeIf { it.features.presence } ?: return@write PositionOutcome.Unavailable
        r.s.presenceRuntime.sharePosition(r.slug, on).also { publish() }
    }

    /**
     * The zone of the selected conference that a deep link (`caddie://e/<slug>#/here/<zone>`) names,
     * or null. [zone] is the link's zone as AppLink decoded it ([PeopleZones.match]).
     */
    fun matchZone(zone: String): String? = PeopleZones.match(_state.value.zones, zone)

    // ---------------------------------------------------------------------------------------------
    // People: search, Around, circles

    /**
     * One page of people at the selected conference, as the web's people list asks for it: with
     * [query] a text search, with [around] the people around now, else the people to meet. Blocked
     * people are left out. A 403 `visibility_required` turns conference-wide visibility off on the
     * device too, because the server copy has gone.
     */
    suspend fun searchPeople(query: String?, around: Boolean, from: Int = 0): ApiResult<MatchesResponse> = read(failedCall()) {
        val r = ready() ?: return@read ApiResult.Failed(PeopleError.notOffered())
        if (around && !r.features.presence) return@read ApiResult.Failed(PeopleError.notOffered())
        search(r, query, around, from)
    }

    private suspend fun search(r: Ready, query: String?, around: Boolean, from: Int): ApiResult<MatchesResponse> {
        val text = query?.trim()?.take(300)?.ifEmpty { null }
        val searching = text != null || around
        val request = MatchesRequest(
            event = r.slug,
            interestedTalkIds = Opt.Of(r.ctx.interested.take(100)),
            query = Opt.orAbsent(text),
            whenNow = when {
                around -> Opt.Of(MatchWhen.AroundNow)
                searching -> Opt.Of(MatchWhen.Anyone)
                else -> Opt.Absent
            },
            from = if (from > 0) Opt.Of(from) else Opt.Absent,
            size = Opt.Of(ConnectRuntime.MATCH_PAGE),
        )
        return when (val res = r.s.api.matches(request)) {
            is ApiResult.Ok -> {
                res.value.results.forEach { r.s.connect.rememberPerson(it) }
                ApiResult.Ok(res.value.copy(results = res.value.results.filter { !r.s.connect.isBlocked(r.slug, it.ref) }))
            }
            is ApiResult.Failed -> {
                if (res.error.kind == PeopleError.Kind.VisibilityRequired || res.error.kind == PeopleError.Kind.NoDevice) {
                    r.s.store.setVisibility(r.slug) { it.copy(openToMeet = false) }
                    publish()
                }
                res
            }
        }
    }

    /**
     * The Around view is showing (or not). While it shows, its first page is fetched and, while my
     * presence is on, fetched again quietly every two minutes (stretched by the API's pace).
     */
    suspend fun setAroundVisible(visible: Boolean): Unit = write(Unit) {
        aroundVisible = visible
        around = around.copy(visible = visible)
        restartAround()
        publish()
    }

    /** Fetches the Around page again now ("See who", pull to refresh). */
    suspend fun refreshAround(): Unit = read(Unit) { loadAround() }

    /**
     * How many people share for each talk, never who; empty without circles. Each talk card may ask
     * for its own talk: the calls that arrive within [COUNT_BATCH_MS] of each other share one
     * request per hundred talks, as the web's useCircleCount does, because the server allows a
     * venue's shared address only 60 such requests a minute. Each caller gets the counts of its own
     * talks. Answers are kept for [COUNT_TTL_MS] (stretched by the API's pace), and so are failures,
     * so a talk whose count failed is not asked for again by every card; a talk that had a count
     * keeps showing it. After a 429, or a 503 that says when to come back, nothing is asked for
     * until that time has passed. While one request is under way, the next batch keeps forming and
     * goes out only when that one has answered, so a fling through a long list costs one request
     * per round trip at most. A caller that stops waiting does not stop the request that others
     * are waiting for.
     */
    suspend fun circleCounts(talkIds: List<String>): Map<String, Int> = read(emptyMap()) {
        val r = ready()?.takeIf { it.features.circles } ?: return@read emptyMap()
        val ids = talkIds.distinct()
        for (batch in countsWanted(r, ids)) batch.done.await()
        knownCounts(r.slug, ids)
    }

    /**
     * Who shares for [talkId], for a device that shares for it too; blocked people are left out. A
     * 403 `share_required` means the server no longer holds the share, so the talk leaves the
     * device's shared list too, as on the web.
     */
    suspend fun circleMembers(talkId: String): ApiResult<CircleMembersResponse> = read(failedCall()) {
        val r = ready()?.takeIf { it.features.circles } ?: return@read ApiResult.Failed(PeopleError.notOffered())
        val res = r.s.api.circleMembers(CircleMembersRequest(r.slug, talkId)).map { res ->
            res.members.forEach { r.s.connect.rememberPerson(it) }
            res.copy(members = res.members.filter { !r.s.connect.isBlocked(r.slug, it.ref) })
        }
        // The server no longer holds this share, so the device forgets it too (TalkPeopleControls.tsx).
        if (res is ApiResult.Failed && res.error.kind == PeopleError.Kind.ShareRequired && talkId in r.s.store.visibility(r.slug).sharedTalkIds) {
            r.s.store.setVisibility(r.slug) { v -> v.copy(sharedTalkIds = v.sharedTalkIds - talkId) }
            invalidateCounts(r.slug, listOf(talkId))
            publish()
        }
        res
    }

    // ---------------------------------------------------------------------------------------------
    // Asks, the inbox and meets

    /**
     * The inbox screen is showing: the inbox is read at once and polled while it shows. A screen
     * that opens before people features are ready is remembered, and the inbox is read once they are.
     */
    suspend fun setInboxVisible(visible: Boolean): Unit = write(Unit) {
        inboxVisible = visible
        val r = ready() ?: return@write
        r.s.connect.setInboxScreen(visible)
        if (visible && r.features.meets) r.s.connect.refreshInbox(r.slug)
        publish()
    }

    /** Reads the inbox now. */
    suspend fun refreshInbox(): Unit = read(Unit) {
        val r = ready()?.takeIf { it.features.meets } ?: return@read
        r.s.connect.refreshInbox(r.slug)
        publish()
    }

    /**
     * "Ask to talk shop" with [note] (trimmed, cut to 140 characters) and, when the subject is a
     * topic, [topicId]; [PeopleText.askPrefill] gives the web's prefilled note. A 409 `meet_open`
     * names the meet already open between the two, which the inbox then follows.
     */
    suspend fun ask(person: Person, note: String, topicId: String? = null): ApiResult<MeetView> = write(failedCall()) {
        val r = ready()?.takeIf { it.features.meets } ?: return@write ApiResult.Failed(PeopleError.notOffered())
        sendAsk(r, person.ref, topicId, note)
    }

    /** "Wave": a one-tap ask to someone in my zone, with the web's note ("I'm in {zone} too — want to talk shop?"). */
    suspend fun wave(person: Person): ApiResult<MeetView> = write(failedCall()) {
        val r = ready()?.takeIf { it.features.meets } ?: return@write ApiResult.Failed(PeopleError.notOffered())
        val p = r.s.presenceRuntime.get(r.slug)
        val zone = if (p.on) p.zone else null
        if (zone == null) {
            return@write ApiResult.Failed(
                PeopleError(403, PeopleError.Kind.PresenceRequired, "presence_required", PeopleError.PRESENCE_REQUIRED_MESSAGE),
            )
        }
        sendAsk(r, person.ref, null, PeopleText.waveNote(zone))
    }

    private suspend fun sendAsk(r: Ready, ref: String, topicId: String?, note: String): ApiResult<MeetView> {
        if (r.s.store.deleteCovers(r.slug)) return ApiResult.Failed(PeopleError.deleteUnfinished())
        val res = r.s.api.requestMeet(
            MeetRequest(event = r.slug, ref = ref, topicId = Opt.of(topicId), note = Opt.Of(note.trim().take(PeopleText.NOTE_MAX))),
        )
        when (res) {
            is ApiResult.Ok -> r.s.connect.noteSentRequest(r.slug, ref, res.value.meetId)
            // The meet already open between us, as the server names it.
            is ApiResult.Failed -> res.error.meetId?.takeIf { res.error.kind == PeopleError.Kind.MeetOpen }?.let { r.s.connect.noteSentRequest(r.slug, ref, it) }
        }
        publish()
        return res
    }

    /** Accepts an ask: the meet becomes active now. A 404 or 410 drops the ask from the inbox (it ran out). */
    suspend fun acceptMeet(meetId: String): ApiResult<MeetView> = inboxAction(meetId) { api, id -> api.acceptMeet(id) }

    /** "Not now": silent; the ask leaves the inbox at once. */
    suspend fun declineMeet(meetId: String): ApiResult<MeetView> = inboxAction(meetId) { api, id -> api.declineMeet(id) }

    private suspend fun inboxAction(meetId: String, call: suspend (PeopleApi, String) -> ApiResult<MeetView>): ApiResult<MeetView> = write(failedCall()) {
        val r = ready()?.takeIf { it.features.meets } ?: return@write ApiResult.Failed(PeopleError.notOffered())
        val res = call(r.s.api, meetId)
        when (res) {
            is ApiResult.Ok -> if (res.value.state == MeetState.Active) r.s.connect.setIncomingState(r.slug, meetId, MeetState.Active) else r.s.connect.dropIncoming(r.slug, meetId)
            is ApiResult.Failed -> if (res.error.status == 404 || res.error.status == 410) r.s.connect.dropIncoming(r.slug, meetId)
        }
        publish()
        res
    }

    /** "We found each other". The inbox is read again, since the meet is over either way. */
    suspend fun foundMeet(meetId: String): ApiResult<MeetView> = meetEnd(meetId) { api, id -> api.foundMeet(id) }

    /** Cancels a meet in any open state. */
    suspend fun cancelMeet(meetId: String): ApiResult<MeetView> = meetEnd(meetId) { api, id -> api.cancelMeet(id) }

    private suspend fun meetEnd(meetId: String, call: suspend (PeopleApi, String) -> ApiResult<MeetView>): ApiResult<MeetView> = write(failedCall()) {
        val r = ready()?.takeIf { it.features.meets } ?: return@write ApiResult.Failed(PeopleError.notOffered())
        val res = call(r.s.api, meetId)
        if (res is ApiResult.Ok || res.errorOrNull?.status == 410) scope.launch { r.s.connect.refreshInbox(r.slug) }
        res
    }

    /**
     * Reads one meet, the only answer with a distance; poll it every [meetPollIntervalMs] while the
     * meet screen shows. Read the zone, spot lines and distance through [PeoplePrivacy].
     */
    suspend fun readMeet(meetId: String): ApiResult<MeetRead> = read(failedCall()) {
        val r = ready()?.takeIf { it.features.meets } ?: return@read ApiResult.Failed(PeopleError.notOffered())
        r.s.api.readMeet(meetId)
    }

    /** My how-to-spot-me line for a meet (cut to 60 characters; empty clears it). */
    suspend fun setSpotMe(meetId: String, spotMe: String): ApiResult<MeetView> = write(failedCall()) {
        val r = ready()?.takeIf { it.features.meets } ?: return@write ApiResult.Failed(PeopleError.notOffered())
        r.s.api.putMeetDetails(meetId, MeetDetailsRequest(spotMe = Opt.Of(spotMe.trim().take(PresenceRuntime.SPOT_MAX))))
    }

    /** The meeting point of a meet: one of the conference's zones, or null to clear it. */
    suspend fun setMeetingPoint(meetId: String, zone: String?): ApiResult<MeetView> = write(failedCall()) {
        val r = ready()?.takeIf { it.features.meets } ?: return@write ApiResult.Failed(PeopleError.notOffered())
        r.s.api.putMeetDetails(meetId, MeetDetailsRequest(rendezvous = Opt.of(zone)))
    }

    /** The open-meet poll interval now: 15 seconds, stretched by the API's pace up to three times. */
    suspend fun meetPollIntervalMs(): Long = read(MEET_POLL_MS) { session?.pace?.pacedMeetMs(MEET_POLL_MS) ?: MEET_POLL_MS }

    /**
     * The person with [ref] as this device last saw them at the current backend (Around, a search,
     * a talk circle) while the app has run, or null. Not a suspend function, so a screen can call it
     * while it draws: after an activity re-creation it finds the person a sheet was open for again.
     */
    fun knownPerson(ref: String): Person? = session?.connect?.knownPerson(ref)

    /** What this device knows of the other person of [meetId] (their opener and about), for after a meet. */
    suspend fun personForMeet(meetId: String): SeenPerson? = read(null) { session?.connect?.personForMeet(meetId) }

    /**
     * "Save this person" after a meet: kept on this device only, under People I met. Returns null
     * once it is stored, or the web's message when it is not (nothing was kept).
     */
    suspend fun saveMet(displayName: String, about: String?): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write noSessionMessage()
        r.s.connect.addMet(r.slug, displayName, about)
        null
    }

    /**
     * Removes [person] (an entry of [PeopleUiState.met]) from People I met. It goes by the entry
     * itself, not its position, so a second tap on the same row removes nothing more. Returns the
     * message for a failure (the entry stays), or null.
     */
    suspend fun removeMet(person: MetPerson): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write noSessionMessage()
        r.s.connect.removeMet(r.slug, person)
        null
    }

    // ---------------------------------------------------------------------------------------------
    // Blocks, reports and the watch list

    /**
     * Blocks a person (after the screen's confirmation with [PeopleText.BLOCK_BODY]). They leave
     * every list at once; if the server refuses, they come back and the web's message is returned.
     */
    suspend fun block(ref: String, displayName: String?): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write PeopleError.NOT_OFFERED_MESSAGE
        r.s.connect.addBlock(r.slug, ref, displayName)
        when (val res = r.s.api.block(BlockRequest(r.slug, ref))) {
            is ApiResult.Ok -> null
            is ApiResult.Failed -> {
                r.s.connect.removeBlock(r.slug, ref)
                res.error.message
            }
        }
    }

    /** Lifts a block, whether or not that profile still exists. Returns the message for a failure, or null. */
    suspend fun unblock(ref: String): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write PeopleError.NOT_OFFERED_MESSAGE
        when (val res = r.s.api.unblock(BlockRequest(r.slug, ref))) {
            is ApiResult.Ok -> {
                r.s.connect.removeBlock(r.slug, ref)
                null
            }
            is ApiResult.Failed -> if (res.error.status == 404) {
                r.s.connect.removeBlock(r.slug, ref)
                null
            } else {
                res.error.message
            }
        }
    }

    /** Reads the server's block list into the cache (Settings, Blocked people); the cached list stands on failure. */
    suspend fun refreshBlocks(): Unit = read(Unit) {
        val r = ready() ?: return@read
        val res = r.s.api.blocks(r.slug) as? ApiResult.Ok ?: return@read
        r.s.connect.mergeBlocks(r.slug, res.value.blocks ?: res.value.refs.map { BlockEntry(it) })
    }

    /** Reports a profile or spot line ([id] is their ref) or a meet ([id] is the meet id; [ref] names the other person). */
    suspend fun report(ref: String, kind: ReportKind, id: String, reason: ReportReason): ApiResult<ReportResponse> = write(failedCall()) {
        val r = ready()?.takeIf { it.features.reports } ?: return@write ApiResult.Failed(PeopleError.notOffered())
        r.s.api.report(ReportRequest(r.slug, ref, ReportContext(kind, id), reason))
    }

    /**
     * "Tell me when they're around": starts watching, or stops. Device-only. Returns the new state,
     * or the web's message when it could not be stored (nothing changed).
     */
    suspend fun toggleWatch(ref: String, displayName: String): WatchOutcome = write(WatchOutcome.Failed(FAILED_MESSAGE)) {
        val r = ready() ?: return@write WatchOutcome.Failed(noSessionMessage())
        WatchOutcome.Done(r.s.connect.toggleWatch(r.slug, ref, displayName))
    }

    /** Stops watching [ref] (Settings, People I'm watching). Returns the message for a failure (they stay watched), or null. */
    suspend fun removeWatch(ref: String): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write noSessionMessage()
        r.s.connect.removeWatch(r.slug, ref)
        null
    }

    // ---------------------------------------------------------------------------------------------
    // Nudges

    /**
     * The nudge setting of the selected conference ([PeopleText.NUDGE_SETTING_LABEL]); on by default.
     * Returns the message for a failure (the setting stays as it was), or null.
     */
    suspend fun setNudgesEnabled(on: Boolean): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write noSessionMessage()
        r.s.connect.setNudgesEnabled(r.slug, on)
        null
    }

    suspend fun dismissNudge(): Unit = write(Unit) { session?.connect?.dismissNudge() }

    /** "See who": closes the banner, sets [PeopleUiState.reveal] and fetches the Around page again. */
    suspend fun seeWho(): Unit = write(Unit) {
        val r = ready() ?: return@write
        val n = r.s.connect.currentNudge(r.slug) ?: return@write
        r.s.connect.seeWho(n)
        loadAround()
    }

    /** The card [PeopleUiState.reveal] named was shown, or the person has left the list. */
    suspend fun consumeReveal(): Unit = write(Unit) { session?.connect?.consumeReveal() }

    // ---------------------------------------------------------------------------------------------
    // Push

    /**
     * Native push nudges on: only when this build's channel is one the backend advertises
     * ([PeopleFeatures.pushChannel]) and the profile is visible at this conference (the server
     * registers push only for a live profile); asks for permission and a token, then registers it.
     * Without a visible profile it answers [PushOutcome.ProfileNeeded] before the system's
     * notification prompt shows.
     */
    suspend fun enablePush(): PushOutcome = write(PushOutcome.Failed(unexpected())) {
        val r = ready() ?: return@write PushOutcome.Unavailable
        val channel = r.features.pushChannel ?: return@write PushOutcome.Unavailable
        if (r.s.store.deleteCovers(r.slug)) return@write PushOutcome.DeleteUnfinished
        val v = r.s.store.visibility(r.slug)
        if (!v.onServer || (!v.openToMeet && v.sharedTalkIds.isEmpty())) return@write PushOutcome.ProfileNeeded
        val token = services.push.register() ?: return@write PushOutcome.Denied
        if (token.channel != channel) return@write PushOutcome.Unavailable
        registerPush(r, token)
    }

    // Sends the token. The environment goes with APNs only (the server refuses it with FCM), and a
    // 404 (push_unavailable, or a server without the route) means no native push on this backend.
    private suspend fun registerPush(r: Ready, token: PushToken): PushOutcome {
        if (!NativePush.validToken(token.channel, token.token)) return PushOutcome.Failed(PeopleError.badResponse(0))
        val request = NativePushPutRequest(r.slug, token.channel, token.token, token.environment.takeIf { token.channel == "apns" })
        return when (val res = r.s.api.putNativePush(request)) {
            is ApiResult.Ok -> {
                r.s.store.update(r.slug) { it.copy(push = PushRecord(on = true, platform = token.channel, token = token.token, noticeSeen = true)) }
                publish()
                PushOutcome.On
            }
            is ApiResult.Failed -> when {
                res.error.status == 404 -> {
                    pushUnavailable += r.s.backend.base
                    publish()
                    PushOutcome.Unavailable
                }
                res.error.kind == PeopleError.Kind.ProfileRequired || res.error.kind == PeopleError.Kind.NoDevice -> PushOutcome.ProfileNeeded
                else -> PushOutcome.Failed(res.error)
            }
        }
    }

    // Push that is on is registered again once per conference and run, so a new token reaches the
    // server (the server takes a repeated PUT as it is).
    private suspend fun renewPush(r: Ready) {
        val rec = r.s.store.record(r.slug).push
        val channel = r.features.pushChannel ?: return
        if (!rec.on || !renewedPush.add("${r.s.backend.base}\n${r.slug}") || r.s.store.deleteCovers(r.slug)) return
        val token = services.push.register() ?: return
        if (token.channel != channel || token.token == rec.token) return
        registerPush(r, token)
    }

    /**
     * Native push nudges off at the selected conference; the device's token goes when no conference
     * uses it. Returns the web's message when the device could not record it: then push stays on,
     * here and on the server, and nothing is sent.
     */
    suspend fun disablePush(): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write noSessionMessage()
        val rec = r.s.store.record(r.slug).push
        r.s.store.update(r.slug, undoOnFailure = true) { it.copy(push = it.push.copy(on = false, platform = null, token = null)) }
        publish()
        val platform = rec.platform
        val token = rec.token
        if (platform != null && token != null) r.s.api.deleteNativePush(NativePushDeleteRequest(r.slug, platform, token))
        if (r.s.store.slugsWithPush().isEmpty()) services.push.unregister()
        null
    }

    /** The push notice ([PeopleText.PUSH_NOTICE]) was shown. Returns the message for a failure (the notice shows again), or null. */
    suspend fun markPushNoticeSeen(): String? = write(FAILED_MESSAGE) {
        val r = ready() ?: return@write noSessionMessage()
        r.s.store.update(r.slug, undoOnFailure = true) { it.copy(push = it.push.copy(noticeSeen = true)) }
        publish()
        null
    }

    // ---------------------------------------------------------------------------------------------
    // How actions run

    /**
     * Runs an action that changes something on the controller's own scope and waits for it. The
     * screens call actions from a scope that ends with the screen, and a write cut off there after
     * the server took it would leave the phone and the server disagreeing: presence on at the
     * server, off on the phone, and an off switch that then sends nothing. So the caller's
     * cancellation only stops the waiting; the action runs to its end and records the answer.
     * Actions still start one at a time in the order they were called. Called from the
     * controller's own work, it runs in place. A failure the action does not expect returns [failed].
     */
    /**
     * "Try again" for records that could not be opened: opens the current backend's session now.
     * True when the session is open now.
     */
    suspend fun retrySession(): Boolean = write(false) { session != null }

    @OptIn(PeopleTestHook::class)
    private suspend fun <T> write(failed: T, block: suspend () -> T): T {
        if (currentCoroutineContext()[Owner]?.controller === this) return guarded(failed, block)
        // A hook that fails is ignored: no action throws.
        return scope.async { guarded(failed, block).also { orElse(Unit) { beforeActionReturns() } } }.await()
    }

    /** Runs a read on the serial dispatcher; it stops when its caller is cancelled. Failures as in [write]. */
    private suspend fun <T> read(failed: T, block: suspend () -> T): T = withContext(serial) { guarded(failed, block) }

    // A session whose records could not be read is tried again first. Nothing is logged: an
    // exception's message can carry people data.
    private suspend fun <T> guarded(failed: T, block: suspend () -> T): T = orElse(failed, onFailure = ::afterFailure) {
        openSession()
        block()
    }

    /** [block]'s value, or [failed] when it throws anything but the cancellation of this coroutine. */
    private suspend fun <T> orElse(failed: T, onFailure: () -> Unit = {}, block: suspend () -> T): T = try {
        block()
    } catch (e: Throwable) {
        if (e is CancellationException && !currentCoroutineContext().isActive) throw e
        onFailure()
        failed
    }

    /** One step of the controller's own work: a failure ends that step, not the work around it. */
    private suspend fun quietly(block: suspend () -> Unit) = orElse(Unit, onFailure = ::afterFailure, block = block)

    private suspend fun applyGuarded(next: PeopleContext?) = orElse(Unit, onFailure = ::afterFailure) { contextLock.withLock { applyContext(next) } }

    // After a failure the screens see the state as it now is, and a session that could not be
    // opened is tried again later.
    private fun afterFailure() {
        openFailed = sessionMissing()
        publish()
        retrySessionLater()
    }

    /** Opens the current backend's session when an earlier attempt could not read its records. */
    private suspend fun openSession() {
        if (!sessionMissing()) return
        // On the controller's own scope, like [write]: openSession can be called from a read that
        // its caller cancels, and a cancel between `session = s` and the timers, watch and poll
        // being installed would leave a session with none of them. The caller's cancellation only
        // stops the waiting.
        if (currentCoroutineContext()[Owner]?.controller === this) {
            contextLock.withLock { context?.takeIf { sessionMissing() }?.let { applyContext(it) } }
        } else {
            scope.async { contextLock.withLock { context?.takeIf { sessionMissing() }?.let { applyContext(it) } } }.await()
        }
    }

    /** True after an attempt to open the current backend's session failed, until a session is registered. */
    private var openFailed = false

    private fun sessionMissing(): Boolean = context?.let { session == null && backendAllowed(it.backend) } == true

    private fun retrySessionLater() {
        if (!sessionMissing() || sessionRetry?.isActive == true) return
        sessionRetry = scope.launch {
            delay(SESSION_RETRY_MS)
            sessionRetry = null
            quietly { openSession() }
        }
    }

    private fun unexpected() = PeopleError(0, PeopleError.Kind.Unavailable, "device_error", PeopleError.UNAVAILABLE_MESSAGE)

    private fun failedCall(): ApiResult<Nothing> = ApiResult.Failed(unexpected())

    /** Marks the coroutines of one controller, so an action called from one of them runs in place. */
    private class Owner(val controller: PeopleController) : AbstractCoroutineContextElement(Owner) {
        companion object Key : CoroutineContext.Key<Owner>
    }

    // ---------------------------------------------------------------------------------------------
    // Internals

    private inner class Session(val backend: BackendUrl.Valid) : SyncHost, PresenceHost, ConnectHost, BleHost {
        val store = PeopleStore(keyValue, backend.base)
        val credentials = DeviceCredentials(services.secureStore, backend)
        override val pace = Pace(this@PeopleController.clock)
        val api = PeopleApi(http, backend, { credentials.forRequest() }, pace, this@PeopleController.clock)
        val sync = ProfileSync(store, api, credentials, scope, this)
        val presenceRuntime = PresenceRuntime(store, api, scope, this)
        val connect = ConnectRuntime(store, api, scope, this)
        val ble = BleRuntime(services.ble, store, api, scope, this)
        var hasDevice = false

        /** No circle counts are asked of this backend before this time (a 429, or a 503 with Retry-After). */
        var countsNotBefore = 0L

        override val clock: Clock get() = this@PeopleController.clock
        override val recordsInMemory: Boolean get() = context?.storageInMemory == true || keyValue.inMemory
        override val location: LocationProvider get() = services.location
        override val notifier: Notifier get() = services.notifier
        override val timeZone: TimeZone get() = this@PeopleController.timeZone

        override fun changed() {
            if (session === this) publish()
        }

        override fun foreground(): Boolean = this@PeopleController.foreground

        override fun gpsBands(): Boolean = context?.let { featuresOf(it).gpsBands } == true

        override fun meets(): Boolean = context?.let { featuresOf(it).meets } == true

        override fun presenceOn(): Boolean = context?.let { featuresOf(it).presence } == true

        override fun presence(slug: String): Presence = presenceRuntime.get(slug)

        override fun topicIds(slug: String): Set<String>? =
            context?.bundle?.takeIf { it.conference.slug == slug }?.topics?.map { it.topicId }?.toSet()

        override fun selectedSlug(): String? = context?.takeIf { it.backend == backend }?.conference?.slug

        override fun listedConferences(): List<ConferenceInfo>? = context?.takeIf { it.backend == backend }?.takeIf { it.listKnown }?.listed

        override suspend fun presenceEndedOnServer(slug: String) = presenceRuntime.presenceEndedOnServer(slug)

        override fun bluetoothRunning(slug: String): Boolean = ble.running(slug)

        override suspend fun presenceChanged(slug: String) = ble.presenceChanged(slug)

        override val backendBase: String get() = backend.base

        override fun bleOffered(): Boolean = context?.let { featuresOf(it) }?.let { it.presence && it.bleMode == Capabilities.BleMode.DerivedV1 } == true

        override fun bleSettings(): Capabilities.Ble = context?.capabilities?.ble ?: Capabilities.Ble()

        override suspend fun writePresenceBle(slug: String, ble: Boolean): ApiResult<PresencePutResponse>? = presenceRuntime.writeBle(slug, ble)

        override suspend fun endPresence(slug: String) = presenceRuntime.turnOff(slug)

        override fun keepUntil(): Boolean = context?.takeIf { it.backend == backend }?.capabilities?.people?.presenceKeepUntil == true

        override fun isBlocked(slug: String, ref: String): Boolean = connect.isBlocked(slug, ref)

        override fun nudgedToday(slug: String, ref: String): Boolean = connect.wasNudgedToday(slug, ref)

        override suspend fun recordNudge(slug: String, ref: String) = connect.recordNudge(slug, ref)

        override fun reveal(slug: String, ref: String) = connect.requestReveal(slug, ref)

        // The toasts of Bluetooth and presence are about the radio or about being around, never
        // about the profile, so they offer no "Open profile".
        override fun notice(message: String) {
            if (session === this) setNotice(message, opensProfile = false)
        }

        override fun bluetoothChanged(slug: String) = presenceRuntime.onBluetoothChanged(slug)

        // Before a delete: Bluetooth stops on the device only, since the delete ends its session.
        override suspend fun stopRuntime(slug: String?) {
            ble.stop(slug)
            if (slug == null) presenceRuntime.reset()
        }

        override suspend fun resetRuntime() {
            ble.stop(null)
            presenceRuntime.reset()
            connect.clearInbox()
            connect.resetNudges()
            around = AroundView(visible = aroundVisible)
            countCache.clear()
        }

        override suspend fun pushDeletedOnServer(slug: String) {
            val rec = store.record(slug).push
            if (!rec.on && rec.token == null) return
            store.update(slug) { it.copy(push = it.push.copy(on = false, platform = null, token = null)) }
            if (store.slugsWithPush().isEmpty()) services.push.unregister()
        }

        override suspend fun forgetPush() {
            for (slug in store.slugsWithPush()) store.update(slug) { it.copy(push = it.push.copy(on = false, platform = null, token = null)) }
            services.push.unregister()
        }

        /**
         * Another backend was selected: the sync timers, the presence timers, the position watch and
         * the inbox poll stop. A write the user asked for that is still under way runs to its end and
         * records the answer here, and this session is taken up again when the backend comes back.
         */
        fun stopAll() {
            sync.stop()
            presenceRuntime.pause()
            connect.stopPoll()
        }
    }

    private class Ready(val s: PeopleController.Session, val ctx: PeopleContext, val slug: String, val features: PeopleFeatures)

    /** The session, context and conference when people features are on and a conference is selected. */
    private fun ready(): Ready? {
        val ctx = context ?: return null
        val s = session ?: return null
        val features = featuresOf(ctx)
        if (!features.enabled) return null
        val slug = ctx.conference?.slug ?: return null
        return Ready(s, ctx, slug, features)
    }

    private fun enabledSession(): Session? {
        val ctx = context ?: return null
        return session?.takeIf { featuresOf(ctx).enabled }
    }

    /**
     * Why [enabledSession] is null, for an action that returns a message: this server offers no
     * people features, or its records are not open (the capabilities are still loading, or the
     * records could not be read), so nothing was kept.
     */
    private fun noSessionMessage(): String =
        if (context?.let { featuresOf(it).enabled } == false) PeopleError.NOT_OFFERED_MESSAGE else FAILED_MESSAGE

    private fun backendAllowed(backend: BackendUrl.Valid): Boolean = allowLocalHttp || backend.base.startsWith("https://")

    private fun featuresOf(ctx: PeopleContext): PeopleFeatures {
        val p = ctx.capabilities.people
        if (!p.enabled || !backendAllowed(ctx.backend)) return PeopleFeatures.OFF
        return PeopleFeatures(
            enabled = true,
            presence = p.presence,
            gpsBands = p.presence && p.gpsBands,
            meets = p.meets,
            circles = p.circles,
            reports = p.reports,
            pushChannel = pushChannel(ctx),
            bleMode = ctx.capabilities.ble.mode,
        )
    }

    /**
     * This build's push channel when the backend advertises it, else null. A backend that answered
     * the registration with 404 has no native push until its capabilities change.
     */
    private fun pushChannel(ctx: PeopleContext): String? {
        if (ctx.backend.base in pushUnavailable) return null
        val channel = services.push.channel ?: return null
        val push = ctx.capabilities.push
        return when (channel) {
            "apns" -> channel.takeIf { push.apns }
            "fcm" -> channel.takeIf { push.fcm }
            else -> null
        }
    }

    private suspend fun applyContext(next: PeopleContext?) {
        val prev = context
        val hadMeets = ready()?.features?.meets == true
        context = next
        if (prev != null && next != null && (prev.backend != next.backend || prev.capabilities.push != next.capabilities.push)) {
            pushUnavailable.remove(next.backend.base)
        }
        if (next == null) {
            publish()
            return
        }
        val backendChanged = session?.backend != next.backend
        if (backendChanged) {
            // Bluetooth belongs to the backend that issued its key: it stops on the device and the
            // keys go, without a request (that backend ends the session with presence).
            session?.ble?.stop(null)
            session?.stopAll()
            session = null
            lastInterested = null
            aroundJob?.cancel()
            around = AroundView(visible = aroundVisible)
            countCache.clear()
            if (backendAllowed(next.backend)) {
                // The backend's own session when it had one ([sessions]). A new one is kept only once
                // its records have been read, so a store that fails here leaves no session half made.
                val s = sessions[next.backend.base] ?: Session(next.backend)
                s.store.load()
                s.hasDevice = s.credentials.get() != null
                s.sync.livePresence = { slug -> s.presenceRuntime.get(slug).on }
                sessions[next.backend.base] = s
                openFailed = false
                session = s
                s.sync.reconcileCredential()?.let { setNotice(it) }
                s.sync.startDeleteRetries()
                // Resumes Bluetooth where it was on (a restart, a restored service or app), or
                // records it as off.
                s.ble.restore()
                // A profile edit still waiting for its one-second pause when this backend was left
                // stopped with the sync timers; it is sent now.
                if (s.sync.status.state == SyncStatus.State.Saving) s.sync.scheduleProfileSync(next.conference?.slug)
            }
        }
        val s = session
        val features = featuresOf(next)
        val slug = next.conference?.slug
        if (s != null) {
            if (features.enabled) {
                s.presenceRuntime.watch(if (features.presence) slug else null)
                // Requests may have opened before people features were ready.
                s.connect.setInboxScreen(inboxVisible)
                if (slug != null && (backendChanged || slug != prev?.conference?.slug)) {
                    around = AroundView(visible = aroundVisible)
                    restartAround()
                    if (features.meets) scope.launch { s.connect.refreshInbox(slug) }
                    ready()?.let { r -> scope.launch { renewPush(r) } }
                } else if (slug != null && features.meets && !hadMeets && inboxVisible) {
                    // Meets came on for the same conference (the capabilities arrived) while
                    // Requests shows: it is read now rather than at the next poll.
                    scope.launch { s.connect.refreshInbox(slug) }
                }
                followInterestedList(s, next, slug)
            } else {
                s.presenceRuntime.watch(null)
                s.connect.stopPoll()
                aroundJob?.cancel()
            }
            // The same backend's capabilities no longer offer Bluetooth (derived-v1 or presence
            // withdrawn): its switch is gone, so it is turned off here, telling the server. A new
            // session decided that in restore() already.
            if (!backendChanged) s.ble.offerChanged()
        }
        publish()
    }

    // Marking or unmarking talks with "sharing follows Interested" on shares or unshares them.
    private fun followInterestedList(s: Session, ctx: PeopleContext, slug: String?) {
        if (slug == null) return
        val key = "${ctx.backend.base}\n$slug"
        val now = ctx.interested.toSet()
        val last = lastInterested
        lastInterested = key to now
        if (last == null || last.first != key) return
        val added = ctx.interested.filter { it !in last.second }
        val removed = last.second.filter { it !in now }
        if (added.isNotEmpty()) {
            scope.launch {
                s.sync.onInterestedChanged(slug, added, marked = true)?.let { setNotice(it) }
                refreshDevice(s)
                publish()
            }
        }
        if (removed.isNotEmpty()) {
            scope.launch {
                s.sync.onInterestedChanged(slug, removed, marked = false)?.let { setNotice(it) }
                publish()
            }
        }
    }

    /**
     * Shows [message] as a toast ([PeopleUiState.notice]). [opensProfile] says whether the toast
     * offers "Open profile"; by default it does when the fix is on the profile screen.
     */
    private fun setNotice(message: String, opensProfile: Boolean = opensProfile(message)) {
        notice = PeopleNotice(message, opensProfile)
        publish()
    }

    /**
     * True when the fix for [message], as an action returned it or a notice carries it, is on the
     * profile screen, so the screen offers "Open profile" next to it. The web offers it when the
     * message speaks of the profile (followShare in web/src/app.tsx); a profile problem is fixed
     * there too, even when its words do not say so (the malformed LinkedIn link). The controller
     * decides this in one place, so no screen reads the wording.
     */
    fun opensProfile(message: String): Boolean =
        message.contains("profile", ignoreCase = true) || message == ProfileSync.profileProblem(session?.store?.profile)

    private suspend fun applyForeground(fg: Boolean) {
        if (foreground == fg) return
        foreground = fg
        val s = session
        if (s != null) {
            if (fg) {
                s.presenceRuntime.onForeground()
                s.sync.startDeleteRetries()
                val r = ready()
                if (r != null && r.features.meets) scope.launch { s.connect.refreshInbox(r.slug) }
                restartAround()
            } else {
                s.presenceRuntime.onBackground()
                aroundJob?.cancel()
                aroundJob = null
            }
        }
        publish()
    }

    private fun restartAround() {
        aroundJob?.cancel()
        aroundJob = null
        val r = ready() ?: return
        if (!aroundVisible || !foreground || !r.features.presence || !r.s.store.visibility(r.slug).openToMeet) return
        aroundJob = scope.launch {
            quietly { loadAround() }
            while (true) {
                delay(r.s.pace.pacedMs(AROUND_REFRESH_MS))
                // The list follows people as they come and go while my presence is on.
                if (foreground && aroundVisible && r.s.presenceRuntime.get(r.slug).on) quietly { loadAround() }
            }
        }
    }

    private suspend fun loadAround() {
        val r = ready()?.takeIf { it.features.presence } ?: return
        val generation = ++aroundGeneration
        around = around.copy(loading = true)
        publish()
        val res = orElse(failedCall()) { search(r, null, around = true, from = 0) }
        if (generation != aroundGeneration) return
        around = when (res) {
            is ApiResult.Ok -> around.copy(loading = false, loaded = true, people = res.value.results, hasMore = res.value.hasMore, error = null)
            is ApiResult.Failed -> around.copy(loading = false, error = res.error)
        }
        publish()
    }

    private fun countKey(slug: String, talkId: String) = "$slug\u001f$talkId"

    private fun invalidateCounts(slug: String, talkIds: List<String>) {
        for (id in talkIds) countCache.remove(countKey(slug, id))
    }

    /** A circle count, or null when it could not be read, kept until [until]. */
    private class CountEntry(val count: Int?, val until: Long)

    /** Talks of one conference whose counts go out together once the batch window has passed. */
    private class CountBatch(val s: PeopleController.Session, val slug: String) {
        val ids = LinkedHashSet<String>()

        /** True once the request is under way; talks asked for after that go in the next batch. */
        var sent = false
        val done = CompletableDeferred<Unit>()
    }

    /**
     * Puts the talks of [ids] whose count is not known (or is out of date) into a batch, and returns
     * the batches to wait for: the one now forming and any already under way for these talks.
     * While the backend has asked to be left alone, nothing is added and what is known stands.
     */
    private fun countsWanted(r: Ready, ids: List<String>): Set<CountBatch> {
        val now = clock.now().toEpochMilliseconds()
        val waits = LinkedHashSet<CountBatch>()
        for (id in ids) {
            val known = countCache[countKey(r.slug, id)]
            if (known != null && now < known.until) continue
            val live = countBatches.firstOrNull { it.s === r.s && it.slug == r.slug && id in it.ids }
            if (live != null) {
                waits += live
                continue
            }
            if (now < r.s.countsNotBefore) continue
            val batch = formingBatch(r)
            batch.ids += id
            waits += batch
        }
        return waits
    }

    private fun formingBatch(r: Ready): CountBatch {
        countBatches.firstOrNull { it.s === r.s && it.slug == r.slug && !it.sent }?.let { return it }
        val b = CountBatch(r.s, r.slug)
        countBatches += b
        // On the controller's scope: a caller that stops waiting leaves the batch to the others.
        scope.launch {
            try {
                delay(COUNT_BATCH_MS)
                // One request at a time per backend: while another batch is under way, this one
                // keeps forming and goes out when that one has answered, so a list that scrolls
                // through many cards sends at most one request per round trip, not one per window.
                while (true) {
                    val underWay = countBatches.firstOrNull { it !== b && it.s === b.s && it.sent } ?: break
                    underWay.done.await()
                }
                b.sent = true
                fetchCounts(b)
            } finally {
                countBatches -= b
            }
        }.invokeOnCompletion { b.done.complete(Unit) }
        return b
    }

    private suspend fun fetchCounts(b: CountBatch) {
        for (chunk in b.ids.toList().chunked(COUNT_CHUNK)) {
            if (clock.now().toEpochMilliseconds() < b.s.countsNotBefore) return
            val res = b.s.api.circleCounts(CircleCountsRequest(b.slug, Opt.Of(chunk)))
            val now = clock.now().toEpochMilliseconds()
            val ttl = b.s.pace.pacedMs(COUNT_TTL_MS)
            if (res is ApiResult.Failed) {
                val e = res.error
                // Over the limit, or the daily budget spent: nothing more until the server's time,
                // at most an hour (a wrong header cannot stop the counts for good), and at least the TTL.
                if (e.status == 429 || e.kind == PeopleError.Kind.DailyLimit) {
                    val wait = max(ttl, min(e.retryAfterSeconds ?: 0, MAX_RETRY_AFTER_S) * 1000)
                    b.s.countsNotBefore = max(b.s.countsNotBefore, now + wait)
                }
            }
            // Counts read from another backend's session are not this one's, and neither are the rest of
            // the batch's chunks: the session changed, so the batch ends here.
            if (session !== b.s) return
            for (id in chunk) {
                val key = countKey(b.slug, id)
                countCache[key] = when (res) {
                    is ApiResult.Ok -> CountEntry(res.value.counts[id] ?: 0, now + ttl)
                    // A failure is kept like an answer, so the cards do not ask again at once; a
                    // count read earlier keeps showing.
                    is ApiResult.Failed -> CountEntry(countCache[key]?.count, max(now + ttl, b.s.countsNotBefore))
                }
            }
        }
    }

    private fun knownCounts(slug: String, ids: List<String>): Map<String, Int> =
        ids.mapNotNull { id -> countCache[countKey(slug, id)]?.count?.let { id to it } }.toMap()

    private fun zonesFor(ctx: PeopleContext): List<String> {
        val bundle = ctx.bundle?.takeIf { it.conference.slug == ctx.conference?.slug }
        val key = "${ctx.conference?.slug}\n${bundle?.contentHash}"
        if (key != zonesKey) {
            zones = PeopleZones.forBundle(bundle)
            zonesKey = key
        }
        return zones
    }

    private fun publish() {
        val ctx = context
        if (ctx == null) {
            _state.value = PeopleUiState(availability = PeopleAvailability.Loading)
            return
        }
        val features = featuresOf(ctx)
        val s = session
        if (!features.enabled) {
            _state.value = PeopleUiState(availability = PeopleAvailability.Off, backend = ctx.backend.base, features = features)
            return
        }
        if (s == null) {
            // The records could not be read yet; they are tried again.
            _state.value = PeopleUiState(availability = PeopleAvailability.Loading, backend = ctx.backend.base, features = features, sessionFailed = openFailed)
            return
        }
        val store = s.store
        val profile = store.profile ?: Profile.EMPTY
        val sync = s.sync
        val conference = ctx.conference
        val slug = conference?.slug
        val deletes = DeletesView(
            unfinished = sync.hasUnfinishedDelete(),
            deleteAll = store.deleteAll != null,
            coversConference = slug != null && store.deleteCovers(slug),
            pendingSlugs = store.slugsDeletePending(),
            detail = sync.pendingDeleteDetail(),
            stopTryingReason = sync.stopTryingReason(),
        )
        if (slug == null) {
            _state.value = PeopleUiState(
                availability = PeopleAvailability.NoConference,
                backend = ctx.backend.base,
                features = features,
                hasDevice = s.hasDevice,
                profile = profile,
                sync = sync.status,
                saveCount = sync.saveCount,
                deletes = deletes,
                notice = notice,
            )
            s.connect.updatePoll(null)
            return
        }
        val record = store.record(slug)
        val presence = s.presenceRuntime.get(slug)
        val zoneList = zonesFor(ctx)
        val connect = s.connect
        _state.value = PeopleUiState(
            availability = PeopleAvailability.Ready,
            backend = ctx.backend.base,
            conference = conference,
            features = features,
            hasDevice = s.hasDevice,
            profile = profile,
            topics = profile.topicsFor(slug),
            visibility = record.visibility,
            sync = sync.status,
            saveCount = sync.saveCount,
            deletes = deletes,
            presence = presence,
            zones = zoneList,
            likelyZones = if (presence.on && presence.confirmPending) s.presenceRuntime.likelyZones(slug, zoneList) else emptyList(),
            lastZone = s.presenceRuntime.lastChosenZone(),
            locationAccess = if (features.gpsBands) services.location.access() else LocationAccess.Unavailable,
            inbox = if (features.meets) {
                InboxView(
                    incoming = connect.incoming(slug),
                    outgoing = connect.outgoing(slug),
                    loaded = connect.inboxLoaded(slug),
                    count = connect.inboxCount(slug),
                    askStates = connect.askStates(slug),
                )
            } else {
                InboxView()
            },
            nudge = if (features.presence) connect.currentNudge(slug) else null,
            nudgesOn = record.nudgesOn,
            reveal = connect.pendingReveal(slug),
            watch = record.watch,
            blocks = record.blocks,
            met = record.met,
            push = PushView(available = features.pushChannel != null, on = record.push.on, noticeSeen = record.push.noticeSeen),
            ble = s.ble.view(slug),
            around = around,
            notice = notice,
        )
        connect.updatePoll(if (features.meets) slug else null)
    }

    /** Follows whether the device has a credential, which a first visible write creates and a finished delete removes. */
    private suspend fun refreshDevice(s: Session) {
        s.hasDevice = s.credentials.get() != null
    }

    companion object {
        /** The open-meet poll at pace 1 (MeetScreen.tsx); stretched by at most 3. */
        const val MEET_POLL_MS = 15_000L

        /** The Around refresh at pace 1; the real wait is stretched by the pace the API reports. */
        const val AROUND_REFRESH_MS = 120_000L

        /** Circle counts are kept this long at pace 1; the API's pace stretches it. */
        const val COUNT_TTL_MS = 60_000L

        /** Circle counts asked for within this window go out in one request (web/src/people/util.tsx). */
        const val COUNT_BATCH_MS = 60L

        /** The most talks one counts request carries. */
        const val COUNT_CHUNK = 100

        /** A session whose records could not be read is tried again after this long. */
        const val SESSION_RETRY_MS = 30_000L

        private const val MAX_RETRY_AFTER_S = 3_600L

        /** What an action that returns a message returns when it failed on the device in a way it does not expect. */
        private const val FAILED_MESSAGE = ProfileSync.GENERIC_MESSAGE

        /**
         * The controller for the app: its records in [records] (the app's [PeopleDatabase], which
         * no backup carries), its requests through [http] (the app's
         * [app.conferencecaddie.shared.net.KtorHttp], which is also the core's
         * [app.conferencecaddie.shared.net.Http]), and the platform's [services]. Bind it to the
         * core with [bind].
         */
        fun create(
            records: PeopleKeyValue,
            http: ApiHttp,
            services: PeopleServices,
            scope: CoroutineScope,
            allowLocalHttp: Boolean,
        ): PeopleController = PeopleController(records, http, services, scope, allowLocalHttp)

        /** Returns a short message when [profile] cannot be sent (no name, a malformed LinkedIn link), else null. */
        fun profileProblem(profile: Profile?): String? = ProfileSync.profileProblem(profile)

        /** True for a message that reports something done for the user (the 50-talk cut, retired topics) rather than a failure. */
        fun isHintMessage(message: String): Boolean = ProfileSync.isHintMessage(message)
    }
}

/**
 * Marks what only tests may use: a hook that does nothing in the app ([PeopleController.beforeActionReturns]).
 * Using it needs an explicit opt-in.
 */
@RequiresOptIn(message = "A test hook: it does nothing in the app, and only tests set it.", level = RequiresOptIn.Level.ERROR)
@Retention(AnnotationRetention.BINARY)
@Target(AnnotationTarget.PROPERTY)
annotation class PeopleTestHook
