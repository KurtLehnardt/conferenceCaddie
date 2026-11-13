package app.conferencecaddie.shared.people

import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.max
import kotlin.math.min
import kotlin.time.Clock
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

/** Where a profile save stands, as the profile screen shows it. */
data class SyncStatus(val state: State, val message: String? = null) {
    enum class State { Idle, Saving, Saved, Error }

    companion object {
        val IDLE = SyncStatus(State.Idle)
    }
}

/** What "Delete my profile" (or a retry of it) ended with. */
data class DeleteResult(
    /** True once the device's people data is gone. */
    val done: Boolean,
    /** What to tell the user. */
    val message: String,
)

/** Why the user may stop trying an unfinished delete. */
enum class StopTryingReason {
    /** The server refused this device's key three times in a row. */
    Forbidden,

    /** Five failed attempts of any kind, or a day of trying. */
    Failing,
}

/** What the controller provides to [ProfileSync]: the rest of the people runtime. */
internal interface SyncHost {
    val clock: Clock

    /**
     * True while the people records last only as long as this launch, because the stored database
     * could not be opened: what the device writes now is gone when the app closes.
     */
    val recordsInMemory: Boolean

    /** The changes of state the screens should see. */
    fun changed()

    /** The topic ids conference [slug] offers today (its installed bundle), or null when unknown. */
    fun topicIds(slug: String): Set<String>?

    /** The selected conference of this backend, or null while none is selected. */
    fun selectedSlug(): String?

    /**
     * Every conference of this backend's list ([PeopleContext.listed]), or null while the list is not
     * known. "Delete my profile" reaches the ones that have not ended even where the records name
     * none, because the records can be lost while the key survives.
     */
    fun listedConferences(): List<ConferenceInfo>?

    /** Presence the server cleared with the profile: off on the device, with its timers. */
    suspend fun presenceEndedOnServer(slug: String)

    /** Before a delete's first request: stops Bluetooth (and for all conferences, every presence timer). */
    suspend fun stopRuntime(slug: String?)

    /** Before "Delete my profile" clears the device: stops everything that runs in memory. */
    suspend fun resetRuntime()

    /** The server deleted this conference's push registration with the profile. */
    suspend fun pushDeletedOnServer(slug: String)

    /** Turns push nudges off everywhere on the device, as part of "Delete my profile". */
    suspend fun forgetPush()
}

/**
 * Writes the device's profile and visibility choices to the server (web/src/people/sync.ts). A
 * document is written only while the user is visible conference-wide or shares for a talk; when
 * both are off, one delete removes it.
 *
 * Deletes and profile writes do not overlap: every profile write and every delete takes one write
 * lock, so a delete waits for the writes already sent to be answered (each has its 20 s time
 * limit), for up to 15 seconds in all. A delete also holds back new writes for the conferences it
 * covers and an edit still waiting for its debounce. If the wait ran out, the delete is sent anyway
 * but counts as unconfirmed, and it is repeated later.
 *
 * A delete is marked on the device before it is sent, and the mark goes only once the server has
 * confirmed it. "Delete my profile" is stored as a whole before its first request and removed only
 * when the device's data goes. While a mark covers a conference, no profile write and no automatic
 * share goes to it; while "Delete my profile" is stored, none goes anywhere. Unfinished deletes are
 * tried again at start-up, when the app comes back to the foreground, and on a timer that waits
 * longer after each failure: 30 seconds, doubling up to 30 minutes, or a longer Retry-After.
 *
 * Every function runs on the controller's serial dispatcher, so state changes between suspension
 * points are atomic, as in the web app's single thread. Work that runs on its own (the debounced
 * save, the quiet re-send, the delete retries) catches a failure of the store, so a failing write
 * leaves an error to show or a later retry, never a state that waits forever.
 */
internal class ProfileSync(
    private val store: PeopleStore,
    private val api: PeopleApi,
    private val credentials: DeviceCredentials,
    private val scope: CoroutineScope,
    private val host: SyncHost,
    // Every profile write and delete takes it; a parameter only so tests can reach its edge cases.
    private val writeLock: Mutex = Mutex(),
) {
    private val clock get() = host.clock
    private fun now() = clock.now().toEpochMilliseconds()

    var status: SyncStatus = SyncStatus.IDLE
        private set

    /** Increases after every successful write, so screens can fetch server results again. */
    var saveCount: Int = 0
        private set

    // The debounce timer of scheduleProfileSync; null when no profile edit is waiting to be sent.
    private var timer: Job? = null
    private class Hold(val slugs: List<String>?)
    private val holds = ArrayList<Hold>()
    private var inFlight = 0
    private val activeDeletes = LinkedHashSet<Deferred<Unit>>()
    private var syncDeferred = false
    private val shareQueue = Mutex()
    private var resendJob: Job? = null
    private var resending = false
    private var retiredNotice: String? = null
    private var retriesStarted = false
    private var retryJob: Job? = null
    private var retrying: Deferred<Boolean>? = null
    private var retryingToken: Any? = null

    private fun setStatus(s: SyncStatus) {
        status = s
        if (s.state == SyncStatus.State.Saved) saveCount++
        host.changed()
    }

    // ---------------------------------------------------------------------------------------------
    // Writes

    private sealed interface Put {
        data class Ok(val res: ProfilePutResponse) : Put

        /** Not sent: a delete covers the conference, or the choices send nothing. */
        data object Held : Put

        /** Not sent: the write lock could not be had in time. */
        data object LockWait : Put

        data class Failed(val error: PeopleError) : Put
    }

    private fun bodyFor(slug: String, p: Profile, v: Visibility): ProfilePutRequest {
        val t = p.topicsFor(slug)
        return ProfilePutRequest(
            event = slug,
            profile = ProfileFields(
                displayName = p.displayName.trim().take(60),
                about = Opt.Of(p.about.trim().take(280)),
                interests = Opt.Of(p.interests.trim().take(500)),
                expertise = Opt.Of(p.expertise.trim().take(500)),
                learnTopics = Opt.Of(t.learn.map { it.topicId }.take(30)),
                speakTopics = Opt.Of(t.speak.map { it.topicId }.take(30)),
                linkedinUrl = Opt.of(p.linkedinUrl.trim().ifEmpty { null }),
                contactNote = Opt.Of(p.contactNote.trim().take(120)),
            ),
            openToMeet = v.openToMeet,
            sharedTalkIds = Opt.Of(v.sharedTalkIds.take(MAX_SHARED_TALKS)),
        )
    }

    private fun messageFor(r: Put): String = when (r) {
        Put.Held -> WRITES_HELD_MESSAGE
        Put.LockWait -> LOCK_WAIT_MESSAGE
        is Put.Failed -> r.error.message
        is Put.Ok -> GENERIC_MESSAGE
    }

    /**
     * Sends one profile write, or answers [Put.Held] while a delete covers its conference or the
     * choices send nothing. The visibility is read at this moment, after the write lock is held.
     */
    private suspend fun sendProfile(slug: String, p: Profile, visibility: (Visibility) -> Visibility?): Put {
        if (writesHeld(slug)) return Put.Held
        val v = visibility(store.visibility(slug)) ?: return Put.Held
        return when (val r = api.putProfile(bodyFor(slug, p, v))) {
            is ApiResult.Ok -> Put.Ok(r.value)
            is ApiResult.Failed -> Put.Failed(r.error)
        }
    }

    /**
     * Sends the profile under the write lock. A topic the server no longer offers is removed from
     * the profile and the write is tried once more; a degraded answer schedules one quiet re-send.
     */
    private suspend fun putChecked(slug: String, p: Profile, visibility: (Visibility) -> Visibility?): Put {
        inFlight++
        try {
            return withWriteLock(SAVE_LOCK_WAIT_MS) { exclusive ->
                if (!exclusive) Put.LockWait else putCheckedNow(slug, p, visibility)
            }
        } finally {
            inFlight--
        }
    }

    private suspend fun putCheckedNow(slug: String, p: Profile, visibility: (Visibility) -> Visibility?): Put {
        retiredNotice = null
        var r = sendProfile(slug, p, visibility)
        if (r is Put.Failed && r.error.status == 400 && UNKNOWN_TOPIC.containsMatchIn(r.error.code ?: "")) {
            val fixed = retireTopics(slug, p) ?: return r
            r = sendProfile(slug, fixed, visibility)
        }
        if (r is Put.Ok && r.res.degraded?.semantic == true) scheduleDegradedResend()
        return r
    }

    /**
     * Removes the topics of conference [slug] that its topic list (the installed bundle) no longer
     * offers and returns the changed profile, or null when nothing can be removed.
     */
    private suspend fun retireTopics(slug: String, p: Profile): Profile? {
        val known = host.topicIds(slug)?.takeIf { it.isNotEmpty() } ?: return null
        val t = p.topicsFor(slug)
        val gone = LinkedHashMap<String, String>()
        fun keep(list: List<TopicRef>) = list.filter { x -> (x.topicId in known).also { if (!it) gone[x.topicId] = x.label } }
        val learn = keep(t.learn)
        val speak = keep(t.speak)
        if (gone.isEmpty()) return null
        val next = p.copy(topics = p.topics + (slug to ConferenceTopics(learn, speak)))
        store.setProfile(next)
        retiredNotice = "$RETIRED_NOTICE_PREFIX: ${gone.values.joinToString(", ")}."
        host.changed()
        return next
    }

    /**
     * Schedules one quiet re-send of the profile to every conference that holds a document, so text
     * the server could not embed gets embedded once it can. A re-send answered degraded again does
     * not schedule another.
     */
    private fun scheduleDegradedResend() {
        if (resending || resendJob != null) return
        resendJob = scope.launch {
            delay(DEGRADED_RESEND_MS)
            resendJob = null
            scope.launch {
                resending = true
                try {
                    resendProfile()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // The store failed. The re-send is quiet and is not repeated; the next edit saves anyway.
                } finally {
                    resending = false
                }
            }
        }
    }

    private suspend fun resendProfile() {
        val p = store.profile ?: return
        if (profileProblem(p) != null) return
        for (slug in store.slugsOnServer()) {
            if (writesHeld(slug)) continue
            val r = putChecked(slug, store.profile ?: p, STORED_CHOICES)
            if (r is Put.Ok) updateHidden(slug, r.res)
        }
    }

    private suspend fun updateHidden(slug: String, res: ProfilePutResponse) {
        val hidden = res.hiddenForOwner == true
        if (hidden != store.visibility(slug).hiddenForOwner) {
            store.setVisibility(slug) { it.copy(hiddenForOwner = hidden) }
            host.changed()
        }
    }

    /**
     * Applies a visibility change for one conference and writes it to the server. On failure the
     * local state is left unchanged and the error message is returned. The exception is turning
     * both choices off when the server may already have hidden the profile: the choice then applies
     * on the device, and the delete stays marked and is tried again. [auto] is set for the
     * automatic share of "sharing follows Interested", which ends quietly when a delete covers the
     * conference by the time its turn comes.
     *
     * A call that ends with an exception (the store could not write, or the call was cancelled)
     * does not leave the status at Saving, and the exception goes on to the caller.
     */
    suspend fun changeVisibility(slug: String, patch: (Visibility) -> Visibility, auto: Boolean = false): String? {
        try {
            return changeVisibilityNow(slug, patch, auto)
        } catch (e: CancellationException) {
            if (status.state == SyncStatus.State.Saving && inFlight == 0) setStatus(SyncStatus.IDLE)
            throw e
        } catch (e: Exception) {
            if (status.state == SyncStatus.State.Saving && inFlight == 0) setStatus(SyncStatus(SyncStatus.State.Error, GENERIC_MESSAGE))
            throw e
        }
    }

    private suspend fun changeVisibilityNow(slug: String, patch: (Visibility) -> Visibility, auto: Boolean): String? {
        deletesSettled()
        if (auto && (!store.visibility(slug).shareNew || writesBlocked(slug))) return null
        var current = store.visibility(slug)
        // The records say the server holds this phone's profile, but the key it was made with is
        // gone: a write would make a second profile under a new key, and a delete could not reach
        // the first. Checked at start-up too (reconcileCredential); this catches a key that could
        // not be read then.
        if ((current.onServer || current.maybeOnServer) && store.deleteAll == null && credentials.lookup() == DeviceCredentials.Lookup.None) {
            return forgetUnreachableProfile()
        }
        if (!patch(current).wantsServer) {
            if (!current.onServer && !current.maybeOnServer) {
                store.setVisibility(slug) { patch(it).copy(onServer = false) }
                host.changed()
                return null
            }
            setStatus(SyncStatus(SyncStatus.State.Saving))
            when (val removed = removeFromServer(slug, patch)) {
                is Removed.Done -> return removed.message
                Removed.ShareInstead -> Unit
            }
            setStatus(SyncStatus.IDLE)
            current = store.visibility(slug)
        }
        // A write now would bring back a profile whose delete has not finished.
        if (writesBlocked(slug)) return DELETE_PENDING_MESSAGE
        val p = store.profile
        profileProblem(p)?.let { return it }
        // Records kept in memory only would forget a profile created now when the app closes, and
        // this phone could then neither show it nor delete it from the server. Nothing new is sent.
        if (!current.onServer && host.recordsInMemory) return PeopleError.RECORDS_IN_MEMORY_MESSAGE
        try {
            credentials.ensure()
        } catch (e: SecureStoreUnavailable) {
            return PeopleError.SECURE_STORE_MESSAGE
        }
        setStatus(SyncStatus(SyncStatus.State.Saving))
        // Until the server answers a first write, it may hold a document or not; a delete covers both.
        val creating = !current.onServer
        // Only the write that set the flag may clear it.
        val flaggedHere = creating && !current.maybeOnServer
        if (creating) store.setVisibility(slug) { it.copy(maybeOnServer = true) }
        return when (val r = putChecked(slug, p!!, patch)) {
            is Put.Ok -> {
                store.setVisibility(slug) {
                    patch(it).copy(
                        openToMeet = r.res.openToMeet,
                        sharedTalkIds = r.res.sharedTalkIds,
                        onServer = r.res.openToMeet || r.res.sharedTalkIds.isNotEmpty(),
                        maybeOnServer = false,
                        hiddenForOwner = r.res.hiddenForOwner == true,
                    )
                }
                // Presence needs conference-wide visibility; the server cleared it with that.
                if (!r.res.openToMeet) host.presenceEndedOnServer(slug)
                setStatus(SyncStatus(SyncStatus.State.Saved))
                null
            }
            else -> {
                val refusedOrUnsent = r == Put.Held || (r is Put.Failed && r.error.status in 400..499)
                if (flaggedHere && refusedOrUnsent) store.setVisibility(slug) { it.copy(maybeOnServer = false) }
                val message = messageFor(r)
                setStatus(SyncStatus(SyncStatus.State.Error, message))
                message
            }
        }
    }

    private class Shared(val ok: Boolean, val message: String?)

    /** The write behind [shareForTalks]; `ok` is true when the shares that fit were written. */
    private suspend fun shareNow(slug: String, talkIds: List<String>, auto: Boolean = false): Shared {
        val current = store.visibility(slug).sharedTalkIds
        val union = (current + talkIds).distinct()
        val cut = union.size > MAX_SHARED_TALKS
        val shared = union.take(MAX_SHARED_TALKS)
        val err = changeVisibility(slug, { it.copy(sharedTalkIds = shared, shareNoticeSeen = true) }, auto)
        if (err != null) return Shared(false, err)
        val retired = retiredNotice
        retiredNotice = null
        return Shared(true, if (cut) CUT_MESSAGE else retired)
    }

    /**
     * Shares for every talk in [talkIds] (keeping existing shares), up to the server's limit of 50.
     * Writes to the shared-talk list run one at a time, each reading the list after the previous
     * write landed. Returns an error or hint message, or null.
     */
    suspend fun shareForTalks(slug: String, talkIds: List<String>): String? = shareQueue.withLock { shareNow(slug, talkIds).message }

    /** Stops sharing for the given talks. Returns an error message, or null. */
    suspend fun unshareTalks(slug: String, talkIds: List<String>, auto: Boolean = false): String? = shareQueue.withLock {
        val current = store.visibility(slug).sharedTalkIds
        val next = current.filter { it !in talkIds }
        if (next.size == current.size) null else changeVisibility(slug, { it.copy(sharedTalkIds = next) }, auto)
    }

    /** Stops sharing for every talk at this conference. Conference-wide visibility is unchanged. */
    suspend fun unshareAll(slug: String): String? = shareQueue.withLock { changeVisibility(slug, { it.copy(sharedTalkIds = emptyList()) }) }

    /**
     * Turns on "sharing follows Interested" and catches up by sharing for every talk already marked.
     * The preference is stored only once that share has succeeded.
     */
    suspend fun followInterested(slug: String, talkIds: List<String>): String? = shareQueue.withLock {
        val r = shareNow(slug, talkIds)
        if (r.ok) {
            store.setVisibility(slug) { it.copy(shareNew = true, shareNoticeSeen = true) }
            host.changed()
        }
        r.message
    }

    /**
     * Talks were marked or unmarked. With "sharing follows Interested" on, marked talks are shared
     * and unmarked ones unshared; otherwise nothing happens and null is returned.
     */
    suspend fun onInterestedChanged(slug: String, talkIds: List<String>, marked: Boolean): String? {
        if (talkIds.isEmpty() || !store.visibility(slug).shareNew || writesBlocked(slug)) return null
        return if (marked) shareQueue.withLock { shareNow(slug, talkIds, auto = true).message } else unshareTalks(slug, talkIds, auto = true)
    }

    /**
     * Debounces profile edits, then writes them to every conference that holds a document: [current]
     * first, then each of the others on its own, so one failure cannot hold the rest up. A
     * conference that has ended takes no visible writes any more, so its visibility is turned off on
     * the device; that is reported only when it is [current]. A conference that a delete covers gets
     * no write.
     */
    fun scheduleProfileSync(current: String?) {
        timer?.cancel()
        timer = null
        val slugs = store.slugsOnServer().filter { !writesBlocked(it) }
        // Every one of them is held by a running delete: the edit is sent once the delete is over.
        if (slugs.isNotEmpty() && slugs.all { heldNow(it) }) syncDeferred = true
        if (slugs.isEmpty() || syncDeferred) {
            if (status.state == SyncStatus.State.Saving && inFlight == 0) setStatus(SyncStatus.IDLE)
            return
        }
        setStatus(SyncStatus(SyncStatus.State.Saving))
        timer = scope.launch {
            delay(SAVE_DEBOUNCE_MS)
            timer = null
            scope.launch { syncNow(current) }
        }
    }

    /**
     * The debounced save. If the store fails part-way, the save ends as an error rather than at
     * Saving, and an edit held back for a delete no longer waits for one that is not running: the
     * next edit is sent as usual.
     */
    private suspend fun syncNow(current: String?) {
        try {
            syncNowUnguarded(current)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (holds.isEmpty()) syncDeferred = false
            setStatus(SyncStatus(SyncStatus.State.Error, GENERIC_MESSAGE))
        }
    }

    private suspend fun syncNowUnguarded(current: String?) {
        val p = store.profile
        val problem = profileProblem(p)
        if (problem != null || p == null) {
            setStatus(SyncStatus(SyncStatus.State.Error, problem))
            return
        }
        var failure: String? = null
        var sent = 0
        for (slug in store.slugsOnServer().sortedBy { it != current }) {
            if (writesBlocked(slug) || !store.visibility(slug).onServer) continue
            if (heldNow(slug)) {
                syncDeferred = true
                continue
            }
            when (val r = putChecked(slug, store.profile ?: p, STORED_CHOICES)) {
                is Put.Ok -> {
                    sent++
                    updateHidden(slug, r.res)
                }
                Put.Held -> syncDeferred = true
                else -> {
                    if (r is Put.Failed && closed(r.error)) {
                        store.setVisibility(slug) { it.copy(onServer = false, openToMeet = false, sharedTalkIds = emptyList()) }
                        if (slug != current) continue
                    }
                    if (failure == null) failure = messageFor(r)
                }
            }
        }
        setStatus(
            when {
                failure != null -> SyncStatus(SyncStatus.State.Error, failure)
                sent > 0 -> SyncStatus(SyncStatus.State.Saved)
                else -> SyncStatus.IDLE
            },
        )
        if (syncDeferred && holds.isEmpty()) {
            syncDeferred = false
            scheduleProfileSync(current)
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Records without their key

    /**
     * Checks the records against the device's key when the controller opens a backend's records.
     * Records that say the server holds this phone's profile somewhere, or that a delete is
     * unfinished, while the secure store holds no key for the backend, came to this phone without
     * it: a move to a new phone, or a backup put back. The profile they describe stays on the server
     * under a key this phone no longer has, so this phone can neither change nor delete it, and a
     * visible write would make a second profile under a new key.
     *
     * The device then stops treating any conference as holding the profile ([forgetUnreachableProfile])
     * and the returned notice says so. An unfinished "Delete my profile" finishes on this phone, as
     * it would without a key anyway, and says what may be left on the server. A secure store that
     * cannot be read now changes nothing: the key may well be there. Returns null when nothing
     * changed, also when the store failed while the records were put right; the next start checks
     * again.
     */
    suspend fun reconcileCredential(): String? = try {
        reconcileNow()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    private suspend fun reconcileNow(): String? {
        if (store.deleteAll == null && unreachable().isEmpty()) return null
        if (credentials.lookup() != DeviceCredentials.Lookup.None) return null
        if (store.deleteAll != null) {
            wipeDevice()
            return DELETED_NO_KEY_MESSAGE
        }
        return forgetUnreachableProfile()
    }

    /** The conferences whose records say the server holds, may hold, or is still deleting this phone's profile. */
    private fun unreachable(): List<String> =
        store.slugsWhere { it.visibility.onServer || it.visibility.maybeOnServer || it.deletePending != null }

    /**
     * For records that came without their key: at every conference they name, the visibility
     * choices (sharing that follows Interested too), presence and push go off on the device and the
     * delete mark goes, because this phone can never finish it. Nothing is sent: a new profile is
     * made only when the user turns visibility on again. Returns the notice for the user.
     */
    private suspend fun forgetUnreachableProfile(): String {
        for (slug in unreachable()) {
            store.update(slug) { r ->
                r.copy(
                    visibility = r.visibility.copy(
                        openToMeet = false,
                        sharedTalkIds = emptyList(),
                        shareNew = false,
                        onServer = false,
                        maybeOnServer = false,
                        hiddenForOwner = false,
                    ),
                    deletePending = null,
                )
            }
            host.presenceEndedOnServer(slug)
            host.pushDeletedOnServer(slug)
        }
        host.changed()
        return KEY_LOST_MESSAGE
    }

    // ---------------------------------------------------------------------------------------------
    // Deletes: holding writes, and the write lock

    private fun heldNow(slug: String): Boolean = holds.any { it.slugs == null || slug in it.slugs }

    /** True while an unfinished delete covers this conference, or "Delete my profile" is unfinished. */
    fun writesBlocked(slug: String): Boolean = store.deleteCovers(slug)

    /** True while no profile write may go to this conference: a delete for it is running or unfinished. */
    fun writesHeld(slug: String): Boolean = heldNow(slug) || writesBlocked(slug)

    /** Resolves once every delete asked for so far is over, or after the wait limit. */
    private suspend fun deletesSettled() {
        val running = activeDeletes.toList()
        if (running.isEmpty()) return
        withTimeoutOrNull(WAIT_MS) { running.awaitAll() }
    }

    /**
     * Runs [fn] holding the write lock. Waiting gives up after [waitMs] and [fn] runs without the
     * lock; [fn] learns whether it holds it.
     *
     * The lock is taken under an owner of this call. The time limit can run out just after the
     * lock was handed over, and the wait then reports a timeout although this call holds the lock;
     * the owner tells, and the lock is given back at once instead of being held for good.
     */
    private suspend fun <T> withWriteLock(waitMs: Long, fn: suspend (exclusive: Boolean) -> T): T {
        val owner = Any()
        val got = if (waitMs <= 0) {
            writeLock.tryLock(owner)
        } else {
            val locked = withTimeoutOrNull(waitMs) {
                writeLock.lock(owner)
                true
            } ?: false
            if (!locked && writeLock.holdsLock(owner)) writeLock.unlock(owner)
            locked
        }
        try {
            return fn(got)
        } finally {
            if (got) writeLock.unlock(owner)
        }
    }

    /**
     * Runs [fn], which sends deletes, with the profile writes for [slugs] (every conference when
     * null) held. The hold starts at once and a profile edit still waiting for its debounce is held
     * back, to be sent when no hold is left. [fn] starts once the earlier deletes are over and every
     * write already sent has been answered, or once 15 seconds have passed; it learns whether every
     * wait finished. If not, a write may still land after the delete, which then has to run again.
     */
    private suspend fun <T> runDelete(slugs: List<String>?, fn: suspend (certain: Boolean) -> T): T {
        val hold = Hold(slugs)
        holds += hold
        if (timer != null) {
            timer?.cancel()
            timer = null
            syncDeferred = true
            if (status.state == SyncStatus.State.Saving && inFlight == 0) setStatus(SyncStatus.IDLE)
        }
        val earlier = activeDeletes.toList()
        val done = CompletableDeferred<Unit>()
        activeDeletes += done
        try {
            val deadline = now() + WAIT_MS
            // An earlier delete that is still running cannot bring a profile back, so it only delays.
            if (earlier.isNotEmpty()) withTimeoutOrNull(max(0, deadline - now())) { earlier.awaitAll() }
            return withWriteLock(deadline - now()) { exclusive ->
                try {
                    fn(exclusive)
                } finally {
                    holds -= hold
                }
            }
        } finally {
            holds -= hold
            if (holds.isEmpty() && syncDeferred) {
                syncDeferred = false
                scheduleProfileSync(null)
            }
            scheduleRetryTimer()
            done.complete(Unit)
            activeDeletes -= done
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Deletes: failures

    /**
     * How a failed delete went. Only the API's own 403 `forbidden` means the server refused this
     * device's key; another 403 and a request that ran out of time say nothing certain, so they
     * count like a 5xx. A device credential the secure store cannot read now is its own kind: no
     * request was sent, and offline is not the reason.
     */
    private fun failureKind(e: PeopleError): DeleteFailure = when {
        e.status == 0 && e.code == "secure_store" -> DeleteFailure.Store
        e.status == 0 -> if (e.kind == PeopleError.Kind.Offline) DeleteFailure.Offline else DeleteFailure.Partial
        e.status == 429 -> DeleteFailure.Rate
        e.status == 403 -> if (e.code == "forbidden") DeleteFailure.Forbidden else DeleteFailure.Partial
        e.status in 400..499 -> DeleteFailure.Bad
        else -> DeleteFailure.Partial
    }

    /**
     * Whether a failed delete may have done part of its work. A 400, 404, its own 403 or a 429 comes
     * before the server changes anything. An unreadable secure store counts like being offline: the
     * mark stays, so the delete runs again once the store can be read.
     */
    private fun mayBePartlyDone(e: PeopleError): Boolean =
        failureKind(e).let { it == DeleteFailure.Partial || it == DeleteFailure.Offline || it == DeleteFailure.Store }

    /** Seconds of the server's Retry-After, at most an hour, so a wrong header cannot stop the retries. */
    private fun retryAfterOf(e: PeopleError): Long = min(e.retryAfterSeconds ?: 0, 3600)

    /**
     * A record after one more failed attempt: the wait doubles from 30 seconds up to 30 minutes, or
     * follows a longer Retry-After. [kind] is null for an attempt that could not finish for a reason
     * no request gave (the conference list is not known).
     */
    private fun afterFailure(r: DeleteRetry, kind: DeleteFailure?, retryAfterSec: Long): DeleteRetry {
        val attempts = r.attempts + 1
        val wait = min(RETRY_MAX_MS.toDouble(), RETRY_FIRST_MS * 2.0.pow(attempts - 1)).toLong()
        return r.copy(
            attempts = attempts,
            nextAt = now() + max(wait, retryAfterSec * 1000),
            forbidden = if (kind == DeleteFailure.Forbidden) r.forbidden + 1 else 0,
            last = kind,
        )
    }

    private fun newRetry() = DeleteRetry(attempts = 0, nextAt = 0, forbidden = 0, last = null, since = now())

    /** True while any delete is unfinished: "Delete my profile", or the server copy at some conference. */
    fun hasUnfinishedDelete(): Boolean = store.deleteAll != null || store.slugsDeletePending().isNotEmpty()

    /** The reason the last attempt at an unfinished delete failed, in plain words, or null. */
    fun pendingDeleteDetail(): String? {
        val all = store.deleteAll
        val last = if (all != null) all.last else store.slugsDeletePending().firstNotNullOfOrNull { store.deletePending(it)?.last }
        return last?.let { PENDING_DETAIL[it] }
    }

    // ---------------------------------------------------------------------------------------------
    // Deletes: sending them

    /**
     * Before the first delete request: nothing that keeps the person findable carries on. Presence
     * ends on the device for each conference concerned and a presence DELETE goes to the server for
     * those where it was on, and Bluetooth stops. Returns true when presence was on at one of them.
     */
    private suspend fun stopActivity(slugs: List<String>, all: Boolean, livePresence: (String) -> Boolean): Boolean {
        try {
            host.stopRuntime(if (all) null else slugs.firstOrNull())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Stopping is best effort; the server ends presence and Bluetooth with the profile anyway.
        }
        val live = slugs.filter(livePresence)
        for (slug in slugs) host.presenceEndedOnServer(slug)
        coroutineScope { live.map { slug -> async { api.deletePresence(slug) } }.awaitAll() }
        return live.isNotEmpty()
    }

    /** Set by the controller: whether presence is on for a conference right now. */
    var livePresence: (String) -> Boolean = { false }

    /** The device stops treating this conference as holding its profile. */
    private suspend fun forgetServerCopy(slug: String) {
        store.setVisibility(slug) { it.copy(onServer = false, maybeOnServer = false, hiddenForOwner = false) }
        store.setDeletePending(slug, null)
    }

    private sealed interface Deleted {
        data object Yes : Deleted

        data object NoKey : Deleted

        data class Failed(val error: PeopleError) : Deleted
    }

    /**
     * Sends the delete for one conference. The conference is marked on the device first (unless the
     * caller already did, [earlier] telling whether a mark was there before), so profile writes stay
     * off for it until the server confirms, even if the app is closed in the middle. The mark goes on
     * success, or when the server refused before changing anything and no earlier attempt had left
     * it; any other failure keeps it, with the time of the next attempt. With [certain] false, a
     * write may still land after the delete, so the mark stays even on success and the delete runs
     * again. Without a device credential nothing on the server can be deleted from here, so the mark
     * goes too.
     */
    private suspend fun deleteOnServer(slug: String, certain: Boolean, earlier: Boolean = store.deletePending(slug) != null): Deleted {
        when (credentials.lookup()) {
            DeviceCredentials.Lookup.None -> {
                forgetServerCopy(slug)
                return Deleted.NoKey
            }
            // The credential may be there but cannot be read now: keep the mark, so the delete runs
            // again later, and never treat this as "nothing on the server".
            DeviceCredentials.Lookup.Unavailable -> {
                if (store.deletePending(slug) == null) store.setDeletePending(slug, newRetry())
                store.updateDeletePending(slug) { afterFailure(it, DeleteFailure.Store, 0) }
                host.changed()
                return Deleted.Failed(PeopleError.secureStoreUnavailable())
            }
            is DeviceCredentials.Lookup.Found -> Unit
        }
        if (store.deletePending(slug) == null) store.setDeletePending(slug, newRetry())
        host.changed()
        when (val r = api.deleteProfile(slug)) {
            is ApiResult.Failed -> {
                val kind = failureKind(r.error)
                if (!earlier && !mayBePartlyDone(r.error)) {
                    store.setDeletePending(slug, null)
                } else {
                    store.updateDeletePending(slug) { afterFailure(it, kind, retryAfterOf(r.error)) }
                }
                host.changed()
                return Deleted.Failed(r.error)
            }
            is ApiResult.Ok -> Unit
        }
        // on_server goes first: if the app stops between the two writes, the mark is still there and
        // the next attempt only repeats a delete that is done.
        store.setVisibility(slug) {
            it.copy(onServer = false, maybeOnServer = false, hiddenForOwner = false, openToMeet = false, sharedTalkIds = emptyList())
        }
        host.presenceEndedOnServer(slug)
        host.pushDeletedOnServer(slug)
        if (certain) {
            store.setDeletePending(slug, null)
        } else {
            store.updateDeletePending(slug) { it.copy(nextAt = now() + RETRY_FIRST_MS, last = null) }
        }
        host.changed()
        return Deleted.Yes
    }

    /**
     * Removes the people data from the device, and its key unless [forgetKey] is false. Only for
     * after the server confirmed every delete, or once the server can hold nothing of this device
     * that a delete from here could reach.
     */
    private suspend fun wipeDevice(forgetKey: Boolean = true) {
        host.forgetPush()
        host.resetRuntime()
        store.clearAllPeopleData()
        if (forgetKey) credentials.forget()
        retryJob?.cancel()
        retryJob = null
        resendJob?.cancel()
        resendJob = null
        setStatus(SyncStatus.IDLE)
    }

    private sealed interface Removed {
        data class Done(val message: String?) : Removed

        data object ShareInstead : Removed
    }

    /** The both-off branch of [changeVisibility]: removes the server copy for one conference. */
    private suspend fun removeFromServer(slug: String, patch: (Visibility) -> Visibility): Removed {
        // The mark goes on before anything waits for the lock, so a queued write finds it and is dropped.
        val earlier = store.deletePending(slug) != null
        if (!earlier) store.setDeletePending(slug, newRetry())
        host.changed()
        var presenceStopped = false
        var failed: PeopleError? = null
        val share = runDelete(listOf(slug)) { certain ->
            // A write answered while this delete waited may have changed the choices.
            if (patch(store.visibility(slug)).wantsServer) {
                if (!earlier) store.setDeletePending(slug, null)
                true
            } else {
                presenceStopped = stopActivity(listOf(slug), false, livePresence)
                val r = deleteOnServer(slug, certain, earlier)
                if (r is Deleted.Failed) failed = r.error
                false
            }
        }
        failed?.let { err ->
            val partlyDone = store.deletePending(slug) != null
            val message = visibilityFailureMessage(failureKind(err), partlyDone) + if (!partlyDone && presenceStopped) PRESENCE_STOPPED else ""
            // The server copy may already be hidden. The choice applies on the device and the delete
            // is tried again; after a refusal nothing changed on the server, so the device keeps the
            // earlier state too.
            if (partlyDone) store.setVisibility(slug, transform = patch)
            setStatus(SyncStatus(SyncStatus.State.Error, message))
            return Removed.Done(message)
        }
        if (share) return Removed.ShareInstead
        store.setVisibility(slug, transform = patch)
        setStatus(SyncStatus(SyncStatus.State.Saved))
        return Removed.Done(null)
    }

    /**
     * "Delete my profile" with the device's key at hand. The records say where the profile is, but
     * they can be lost while the key survives: a database replaced after it could not be opened, or
     * an iPhone app deleted and installed again, which keeps the Keychain. So the selected
     * conference and every conference of the backend's list that has not ended are marked for a
     * delete as well, as the conferences the records name are; the server answers a delete with
     * nothing to delete with 200. A conference that has ended needs none: the server shows nothing
     * there any more and removes what it held. The list is marked once per "Delete my profile", so
     * a retry sends only what is still unconfirmed; while the list is not known, only the selected
     * conference is marked, and the delete cannot finish.
     */
    private suspend fun markReachable() {
        val all = store.deleteAll ?: return
        if (all.listReached) return
        val listed = host.listedConferences()
        val now = now()
        val slugs = listOfNotNull(host.selectedSlug()) + listed.orEmpty().filter { ConferenceWindow.isLive(it, now) }.map { it.slug }
        for (slug in slugs.distinct()) if (store.deletePending(slug) == null) store.setDeletePending(slug, newRetry())
        if (listed != null) store.updateDeleteAll { it.copy(listReached = true) }
    }

    /**
     * One pass of "Delete my profile": deletes on the server for every conference that holds the
     * profile, may hold it, or has an unfinished delete, and with the device's key also for every
     * conference still running ([markReachable]). The device's data goes only when the server has
     * confirmed every one of them, and the key only when at least one delete was confirmed: without
     * one, nothing says the server holds nothing under it. While the key cannot be read, or the
     * conference list is not known, the delete stays unfinished and is tried again.
     */
    private suspend fun deleteEverywhere(certain: Boolean): DeleteResult {
        if (store.deleteAll == null) return DeleteResult(true, DELETED_MESSAGE)
        val key = credentials.lookup()
        if (key is DeviceCredentials.Lookup.Found) markReachable()
        val targets = (store.slugsMaybeOnServer() + store.slugsDeletePending()).distinct()
        val presenceStopped = stopActivity(targets, true, livePresence)
        var worst: DeleteFailure? = null
        var retryAfter = 0L
        var noKey = false
        var deleted = 0
        for (slug in targets) {
            when (val r = deleteOnServer(slug, certain)) {
                Deleted.NoKey -> noKey = true
                Deleted.Yes -> deleted++
                is Deleted.Failed -> {
                    val kind = failureKind(r.error)
                    if (worst == null || FAILURE_RANK.getValue(kind) > FAILURE_RANK.getValue(worst)) worst = kind
                    retryAfter = max(retryAfter, retryAfterOf(r.error))
                    // The server limits writes per device: with many conferences marked, the rest of
                    // this pass would be refused too, and the retry after the wait sends them.
                    if (kind == DeleteFailure.Rate) break
                }
            }
        }
        val w = worst
        if (w != null) {
            store.updateDeleteAll { afterFailure(it, w, retryAfter) }
            host.changed()
            val progress = when {
                store.slugsDeletePending().isNotEmpty() -> Progress.Partial
                deleted > 0 -> Progress.Some
                else -> Progress.None
            }
            return DeleteResult(false, profileFailureMessage(w, progress) + if (presenceStopped) PRESENCE_STOPPED_UNTIL_DONE else "")
        }
        if (store.slugsDeletePending().isNotEmpty() || store.slugsMaybeOnServer().isNotEmpty()) {
            store.updateDeleteAll { it.copy(nextAt = now() + RETRY_FIRST_MS, last = null) }
            host.changed()
            return DeleteResult(false, ALMOST_DONE_MESSAGE)
        }
        when (key) {
            // The key may be there but cannot be read: nothing is cleared, and nothing is claimed.
            DeviceCredentials.Lookup.Unavailable -> {
                store.updateDeleteAll { afterFailure(it, DeleteFailure.Store, 0) }
                host.changed()
                return DeleteResult(false, PeopleError.SECURE_STORE_MESSAGE)
            }
            is DeviceCredentials.Lookup.Found -> {
                if (store.deleteAll?.listReached != true) {
                    // Done where the records and the selected conference say, but other running
                    // conferences may hold the profile: the key stays until the list is known.
                    store.updateDeleteAll { afterFailure(it, null, 0) }
                    host.changed()
                    return DeleteResult(false, listUnknownMessage(deleted > 0))
                }
                if (deleted == 0) {
                    // No conference is still running and none holds the profile; with no delete
                    // confirmed, keeping the key is harmless and claims nothing about the server.
                    wipeDevice(forgetKey = false)
                    return DeleteResult(true, DELETED_FROM_PHONE_MESSAGE)
                }
                wipeDevice()
                return DeleteResult(true, DELETED_MESSAGE)
            }
            DeviceCredentials.Lookup.None -> {
                wipeDevice()
                // Without a key this phone deleted nothing on the server.
                return DeleteResult(true, if (noKey) DELETED_NO_KEY_MESSAGE else DELETED_FROM_PHONE_MESSAGE)
            }
        }
    }

    /**
     * "Delete my profile". The request is stored on the device before anything is sent, and only the
     * final clearing of the device removes it, so a refusal, a failure or a closed app cannot make
     * the device forget it: the retries carry on until every conference is done.
     */
    suspend fun deleteMyProfile(): DeleteResult {
        // The stored records, which say where the profile is, could not be opened. A delete from
        // what this launch knows would find nothing to delete, clear the device and forget its key,
        // and any profile the stored records know about could then never be deleted from this phone.
        if (host.recordsInMemory) return DeleteResult(false, PeopleError.RECORDS_IN_MEMORY_DELETE_MESSAGE)
        if (store.deleteAll == null) store.setDeleteAll(newRetry())
        host.changed()
        return runDelete(null) { deleteEverywhere(it) }
    }

    private fun isDue(r: DeleteRetry?): Boolean = r != null && r.nextAt <= now()

    /**
     * One retry pass. With [onlyDue], deletes whose next attempt is not due yet are left alone. A
     * pass that has not finished after two minutes is no longer waited for.
     */
    private suspend fun retryPass(onlyDue: Boolean): Boolean {
        retrying?.let { return it.await() }
        val run = scope.async { retryPassNow(onlyDue) }
        val token = Any()
        retryingToken = token
        val bounded = scope.async {
            try {
                withTimeoutOrNull(RETRY_PASS_MAX_MS) { run.await() } ?: false
            } finally {
                if (retryingToken === token) {
                    retrying = null
                    retryingToken = null
                }
            }
        }
        retrying = bounded
        return bounded.await()
    }

    private suspend fun retryPassNow(onlyDue: Boolean): Boolean {
        if (store.deleteAll != null) {
            if (!onlyDue || isDue(store.deleteAll)) runDelete(null) { deleteEverywhere(it) }
        } else {
            val slugs = store.slugsDeletePending().filter { !onlyDue || isDue(store.deletePending(it)) }
            if (slugs.isNotEmpty()) {
                runDelete(slugs) { certain ->
                    for (slug in slugs) {
                        if (store.deletePending(slug) == null) continue
                        deleteOnServer(slug, certain)
                    }
                }
            }
        }
        return !hasUnfinishedDelete()
    }

    /**
     * Tries every unfinished delete again now, as the Try again button does. True when nothing is
     * left unfinished; false too when the store failed, since the delete is then still unfinished.
     */
    suspend fun finishPendingDeletes(): Boolean = try {
        retryPass(false)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        false
    }

    private fun stuck(r: DeleteRetry?): StopTryingReason? {
        if (r == null) return null
        if (r.forbidden >= STOP_AFTER_FORBIDDEN) return StopTryingReason.Forbidden
        if (r.attempts >= STOP_AFTER_ATTEMPTS || now() - r.since >= STOP_AFTER_MS) return StopTryingReason.Failing
        return null
    }

    /**
     * Why the user may stop trying, or null: after three refusals of the device's key in a row,
     * five failed attempts of any kind, or a day of trying.
     */
    fun stopTryingReason(): StopTryingReason? {
        store.deleteAll?.let { return stuck(it) }
        val reasons = store.slugsDeletePending().map { stuck(store.deletePending(it)) }
        return when {
            StopTryingReason.Forbidden in reasons -> StopTryingReason.Forbidden
            StopTryingReason.Failing in reasons -> StopTryingReason.Failing
            else -> null
        }
    }

    /**
     * Gives up on unfinished deletes. After "Delete my profile" the device's data goes; otherwise
     * the device stops treating the stuck conferences as holding the profile. Returns the message
     * after "Delete my profile", else null.
     */
    suspend fun stopTrying(): String? = runDelete(null) {
        if (store.deleteAll != null) {
            wipeDevice()
            DELETED_HERE_MESSAGE
        } else {
            for (slug in store.slugsDeletePending()) if (stuck(store.deletePending(slug)) != null) forgetServerCopy(slug)
            host.changed()
            null
        }
    }

    /**
     * Starts the retry the app runs on its own: only when due. A pass the store made fail is tried
     * again, no sooner than the first backoff step, so a store that keeps failing cannot make the
     * retries run in a tight loop.
     */
    private suspend fun backgroundRetry() {
        retryJob?.cancel()
        retryJob = null
        if (!hasUnfinishedDelete()) return
        try {
            retryPass(true)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            scheduleRetryTimer(RETRY_FIRST_MS)
            return
        }
        scheduleRetryTimer()
    }

    /** Sets the timer for the next due retry, at least [floorMs] away, once retries have started. */
    private fun scheduleRetryTimer(floorMs: Long = 0) {
        if (!retriesStarted) return
        retryJob?.cancel()
        retryJob = null
        val all = store.deleteAll
        val times = if (all != null) listOf(all.nextAt) else store.slugsDeletePending().map { store.deletePending(it)?.nextAt ?: 0 }
        if (times.isEmpty()) return
        val wait = maxOf(5_000L, floorMs, times.min() - now())
        retryJob = scope.launch {
            delay(wait)
            retryJob = null
            scope.launch { backgroundRetry() }
        }
    }

    /**
     * Tries unfinished deletes again now and from then on whenever they are due. The controller
     * calls it at start-up and whenever the app comes back to the foreground.
     */
    fun startDeleteRetries() {
        retriesStarted = true
        scope.launch { backgroundRetry() }
    }

    /** Stops every timer of this backend's sync, when the controller switches to another backend. */
    fun stop() {
        // The controller keeps this session and may take it up again, so the timers are also
        // forgotten: a cancelled job left here would hold back the next degraded re-send, and a
        // cancelled debounce would still read as an edit waiting to be sent.
        timer?.cancel()
        timer = null
        resendJob?.cancel()
        resendJob = null
        retryJob?.cancel()
        retryJob = null
        retriesStarted = false
    }

    private enum class Progress { None, Some, Partial }

    companion object {
        /** The server's limit of shared talks per profile. */
        const val MAX_SHARED_TALKS = 50

        const val SAVE_DEBOUNCE_MS = 1_000L

        /** The server pauses embedding for 60 s after a failure; the re-send waits a little longer. */
        const val DEGRADED_RESEND_MS = 70_000L

        /** How long a delete waits for earlier deletes and writes in flight, in all. */
        const val WAIT_MS = 15_000L

        /** How long a save waits for the write lock; longer than a request may take. */
        const val SAVE_LOCK_WAIT_MS = 25_000L

        const val RETRY_FIRST_MS = 30_000L
        const val RETRY_MAX_MS = 30 * 60_000L
        const val STOP_AFTER_FORBIDDEN = 3
        const val STOP_AFTER_ATTEMPTS = 5
        const val STOP_AFTER_MS = 24 * 60 * 60_000L
        const val RETRY_PASS_MAX_MS = 120_000L

        val LINKEDIN = Regex("^https://(www\\.)?linkedin\\.com/in/[A-Za-z0-9_-]{3,100}/?$")
        private val UNKNOWN_TOPIC = Regex("_topics contains an unknown topic")
        private val CLOSED = Regex("^conference (has ended|is not available)")

        /** For an edit: the stored choices, and only while the conference still holds a document. */
        private val STORED_CHOICES: (Visibility) -> Visibility? = { fresh -> if (fresh.onServer) fresh else null }

        private fun closed(e: PeopleError) = e.status == 400 && CLOSED.containsMatchIn(e.code ?: "")

        /** Returns a short message when the profile cannot be sent, else null. */
        fun profileProblem(p: Profile?): String? {
            if (p == null || p.displayName.isBlank()) return "Add your name to your profile first."
            val url = p.linkedinUrl.trim()
            if (url.isNotEmpty() && !LINKEDIN.matches(url)) return "The LinkedIn link should look like https://www.linkedin.com/in/your-name."
            return null
        }

        /** Starts the note that tells the user which topics were removed. Also marks it as a hint, not an error. */
        const val RETIRED_NOTICE_PREFIX = "Topics the conference list no longer offers were removed from your profile"

        const val CUT_MESSAGE = "You can share for up to $MAX_SHARED_TALKS talks, so the first $MAX_SHARED_TALKS are shared."

        /** True for messages that report something done for the user rather than a failure. */
        fun isHintMessage(message: String): Boolean = message == CUT_MESSAGE || message.startsWith(RETIRED_NOTICE_PREFIX)

        /** Shown when the user asks to share while a delete covers the conference. */
        const val DELETE_PENDING_MESSAGE = PeopleError.DELETE_UNFINISHED_MESSAGE

        /** Shown in the rare case a write is stopped because a delete started at the same moment. */
        const val WRITES_HELD_MESSAGE = "Your profile is being removed, so that was not saved."

        /** Shown when a save waited too long for another write or delete. */
        const val LOCK_WAIT_MESSAGE = "Saving had to wait too long for another tab or a slow connection. Try again in a moment."

        const val GENERIC_MESSAGE = "That could not be saved. Please try again."

        /** Shown once "Delete my profile" has finished. */
        const val DELETED_MESSAGE = "Your profile was deleted from this phone and from our server."

        private const val LEFT_ON_SERVER =
            "What our server holds may stay visible to other attendees until the conference ends, and this phone can no longer delete it."

        /** Shown when the device's data went but this device had no key to delete the server copy with. */
        const val DELETED_NO_KEY_MESSAGE =
            "Your profile was deleted from this phone, which no longer had the key needed to delete it from our server. $LEFT_ON_SERVER"

        /** Shown when the user stopped trying after "Delete my profile". */
        const val DELETED_HERE_MESSAGE = "Your profile was deleted from this phone only. $LEFT_ON_SERVER"

        /**
         * Shown when "Delete my profile" cleared this phone without a delete on the server to
         * confirm: the phone had no key, or no conference was still running.
         */
        const val DELETED_FROM_PHONE_MESSAGE = "Your profile was deleted from this phone."

        /**
         * Shown when the records say this phone's profile is on the server but the key it was made
         * with is gone, as after a move to a new phone or a restore from a backup.
         */
        const val KEY_LOST_MESSAGE =
            "This phone no longer has the key for the profile made on it before, for example after a move to a new phone or a restore from a backup. " +
                "That profile may stay visible to other attendees until the conference ends, and this phone cannot delete it. " +
                "Turning visibility on makes a new profile."

        /** Shown when every delete went through while a profile write may still have been in flight. */
        const val ALMOST_DONE_MESSAGE =
            "Your profile was deleted from our server. A change sent just before may still arrive, so the app deletes it once more shortly and then clears this phone."

        /** Added to a refusal that left the profile in place when presence had been on. */
        const val PRESENCE_STOPPED = " Your presence was turned off. You can turn it on again."
        const val PRESENCE_STOPPED_UNTIL_DONE = " Your presence was turned off until the delete is done."

        private val FAILURE_RANK = mapOf(
            DeleteFailure.Partial to 4,
            DeleteFailure.Offline to 3,
            DeleteFailure.Store to 3,
            DeleteFailure.Forbidden to 2,
            DeleteFailure.Rate to 1,
            DeleteFailure.Bad to 0,
        )

        /** The extra line the unfinished-delete notice shows after an attempt failed for a known reason. */
        val PENDING_DETAIL: Map<DeleteFailure, String?> = mapOf(
            DeleteFailure.Partial to null,
            DeleteFailure.Offline to "You appear to be offline.",
            DeleteFailure.Store to PeopleError.SECURE_STORE_MESSAGE,
            DeleteFailure.Rate to "Too many requests right now. Wait a minute and try again.",
            DeleteFailure.Forbidden to "This device is not allowed to delete your profile.",
            DeleteFailure.Bad to "Our server could not handle the request. Try again later, or update the app.",
        )

        /** What "Delete my profile" tells the user when it did not finish. */
        private fun profileFailureMessage(kind: DeleteFailure, progress: Progress): String {
            val partly = if (progress == Progress.Partial) " It may be partly deleted." else ""
            val notYet = if (progress == Progress.None) "your profile was not deleted yet" else "deleting your profile has not finished"
            return when (kind) {
                DeleteFailure.Partial ->
                    "Your profile may be partly deleted: it may already be hidden from other attendees, but deleting it did not finish. Try again to finish."
                DeleteFailure.Offline -> "You appear to be offline. Your profile may be partly deleted. Try again to finish once you are online."
                DeleteFailure.Store -> PeopleError.SECURE_STORE_MESSAGE
                DeleteFailure.Rate -> "Too many requests right now, so $notYet.$partly Wait a minute and try again."
                DeleteFailure.Forbidden ->
                    if (progress == Progress.None) {
                        "This device is not allowed to delete your profile, so it was not deleted."
                    } else {
                        "This device is not allowed to finish deleting your profile.$partly"
                    }
                DeleteFailure.Bad -> "Our server could not handle the request, so $notYet.$partly Try again later, or update the app."
            }
        }

        /** What "Delete my profile" tells the user while the conference list it needs is not known. */
        private fun listUnknownMessage(someDeleted: Boolean): String {
            val notYet = if (someDeleted) "deleting your profile has not finished" else "your profile was not deleted yet"
            return "The app needs the list of conferences to find everywhere our server may hold your profile and could not read it, so $notYet. " +
                "Try again to finish once you are online."
        }

        /** What turning both visibility choices off tells the user when removing the server copy failed. */
        private fun visibilityFailureMessage(kind: DeleteFailure, partlyDone: Boolean): String {
            val hidden = " It may already be hidden from others at this conference."
            return when (kind) {
                DeleteFailure.Partial ->
                    "Your profile may already be hidden from others at this conference, but removing it did not finish. The app will try again, or you can finish it from your profile."
                DeleteFailure.Offline -> "You appear to be offline, so removing your profile did not finish.$hidden The app will try again once you are online."
                DeleteFailure.Store -> PeopleError.SECURE_STORE_MESSAGE
                DeleteFailure.Rate ->
                    if (partlyDone) {
                        "Too many requests right now, so removing your profile has not finished.$hidden Wait a minute and try again."
                    } else {
                        "Too many requests right now, so nothing changed. Wait a minute and try again."
                    }
                DeleteFailure.Forbidden ->
                    if (partlyDone) {
                        "This device is not allowed to finish removing your profile.$hidden"
                    } else {
                        "This device is not allowed to remove your profile, so nothing changed."
                    }
                DeleteFailure.Bad ->
                    if (partlyDone) {
                        "Our server could not handle the request, so removing your profile has not finished.$hidden"
                    } else {
                        "Our server could not handle the request, so nothing changed. Try again later, or update the app."
                    }
            }
        }
    }
}

private fun Double.pow(n: Int): Double {
    var r = 1.0
    repeat(n) { r *= this }
    return r
}
