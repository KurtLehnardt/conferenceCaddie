package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.Demo
import app.conferencecaddie.shared.Notifier
import kotlin.math.max
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/** The banner of an in-app nudge (nudges.ts). */
data class Nudge(
    val slug: String,
    /** The person the banner is about; a key for "See who", never shown. */
    val ref: String,
    val zone: String,
    /** The full banner sentence, built once so it never changes under the reader. */
    val text: String,
    /** True for a nudge about someone on the watch list (it names them); false for a strong match (it never names anyone). */
    val watched: Boolean,
)

/** What this device remembers of a person it has seen, for the opener and about after a meet. */
data class SeenPerson(val displayName: String, val about: String?, val opener: String?, val reasons: List<String>)

/** What the controller provides to [ConnectRuntime]. */
internal interface ConnectHost {
    val clock: Clock
    val pace: Pace
    val notifier: Notifier
    val timeZone: TimeZone

    fun changed()

    fun foreground(): Boolean

    /** Presence of [slug] as it stands now. */
    fun presence(slug: String): Presence

    /** True when the backend offers asks and meets (`people.meets`). */
    fun meets(): Boolean

    /** True when the backend offers presence (`people.presence`). */
    fun presenceOn(): Boolean

    /** True when [slug] is a demo conference, so a notification about it says so. */
    fun demo(slug: String): Boolean
}

/**
 * Find & connect state shared across screens (web/src/people/connect.ts, nudges.ts and watch.ts):
 * the inbox poll, what this device has asked, which people it has seen, the blocks cache, the
 * in-app nudges and the watch list.
 *
 * The inbox is polled every 45 seconds (stretched by the API's pace, and never sooner than a
 * Retry-After) while the app is in the foreground and presence is on, a request of ours is open, or
 * the inbox screen is showing. The nudge check runs on every third tick: one `around_now` request,
 * and the first strong match in my zone not nudged today (or else someone I watch who is around)
 * becomes the banner, at most once per person per day, recorded on the device.
 */
internal class ConnectRuntime(
    private val store: PeopleStore,
    private val api: PeopleApi,
    private val scope: CoroutineScope,
    private val host: ConnectHost,
) {
    private fun now() = host.clock.now().toEpochMilliseconds()

    private class Asked(val meetId: String, val at: Long)

    private var inboxSlug: String? = null
    private var incoming: List<MeetView> = emptyList()
    private var outgoing: List<MeetView> = emptyList()
    private var inboxLoaded = false
    private val asked = LinkedHashMap<String, Asked>()
    private val meetRefs = HashMap<String, String>()
    private val seen = HashMap<String, SeenPerson>()
    private var inboxGeneration = 0
    private var inboxScreen = false
    private var pollJob: Job? = null
    private var pollSlug: String? = null
    private var notBefore = 0L

    // The one banner, and the person "See who" should land on.
    var current: Nudge? = null
        private set
    private var reveal: Pair<String, String>? = null
    private var nudgeGeneration = 0

    // ---------------------------------------------------------------------------------------------
    // People seen

    fun rememberPerson(p: Person) {
        seen[p.ref] = SeenPerson(p.displayName, p.about, p.opener?.ifEmpty { null }, p.reasons)
        // The latest card of each person, the newest [KNOWN_PEOPLE] kept, in an immutable map that
        // any thread may read ([knownPerson]).
        val next = LinkedHashMap(known)
        next.remove(p.ref)
        next[p.ref] = p
        while (next.size > KNOWN_PEOPLE) next.remove(next.keys.first())
        known = next
    }

    @kotlin.concurrent.Volatile
    private var known: Map<String, Person> = emptyMap()

    /**
     * The person with [ref] as this device last saw them (Around, a search, a talk circle) while the
     * app has run, or null. Safe to call from any thread: the screens use it to find the person a
     * sheet was open for again after the activity was re-created.
     */
    fun knownPerson(ref: String): Person? = known[ref]

    private fun rememberIncoming(r: MeetView) {
        val from = r.from ?: return
        val prev = seen[from.ref]
        seen[from.ref] = SeenPerson(from.displayName, from.about ?: prev?.about, prev?.opener, prev?.reasons ?: emptyList())
    }

    fun personForMeet(meetId: String): SeenPerson? = meetRefs[meetId]?.let { seen[it] }

    // ---------------------------------------------------------------------------------------------
    // Inbox

    private fun resetInbox(slug: String) {
        inboxSlug = slug
        incoming = emptyList()
        outgoing = emptyList()
        inboxLoaded = false
        asked.clear()
        inboxGeneration++
    }

    /** Forgets every request, meet and person this session knew, for "Delete my profile". */
    fun clearInbox() {
        inboxGeneration++
        inboxSlug = null
        incoming = emptyList()
        outgoing = emptyList()
        inboxLoaded = false
        asked.clear()
        meetRefs.clear()
        seen.clear()
        known = emptyMap()
        host.changed()
    }

    fun incoming(slug: String): List<MeetView> =
        if (inboxSlug != slug) emptyList() else incoming.filter { r -> r.from?.ref?.let { !isBlocked(slug, it) } ?: true }

    fun outgoing(slug: String): List<MeetView> =
        if (inboxSlug != slug) emptyList() else outgoing.filter { r -> r.to?.ref?.let { !isBlocked(slug, it) } ?: true }

    fun inboxLoaded(slug: String): Boolean = inboxSlug == slug && inboxLoaded

    /** Incoming requests waiting for an answer: the People tab's badge. */
    fun inboxCount(slug: String): Int = incoming(slug).count { it.state == MeetState.Requested }

    /** The state of this device's open request to [ref], or null. */
    fun requestTo(slug: String, ref: String): MeetState? {
        outgoing(slug).firstOrNull { it.to?.ref == ref && it.state.isOpen }?.let { return it.state }
        val a = asked[ref] ?: return null
        return if (inboxSlug == slug && now() - a.at <= ASKED_MAX_MS) MeetState.Requested else null
    }

    /** Every ref this device has an open request to, with its state. */
    fun askStates(slug: String): Map<String, MeetState> {
        val out = LinkedHashMap<String, MeetState>()
        if (inboxSlug == slug) for ((ref, a) in asked) if (now() - a.at <= ASKED_MAX_MS) out[ref] = MeetState.Requested
        for (m in outgoing(slug)) {
            val ref = m.to?.ref ?: continue
            if (m.state.isOpen) out[ref] = m.state
        }
        return out
    }

    fun noteSentRequest(slug: String, ref: String, meetId: String) {
        if (inboxSlug != slug) resetInbox(slug)
        meetRefs[meetId] = ref
        // A 409 that names their ask to me: it waits in my inbox for my answer, not for theirs.
        if (incoming.none { it.meetId == meetId }) asked[ref] = Asked(meetId, now())
        host.changed()
    }

    /** Fetches the inbox once. Errors are kept quiet: the next poll tries again. */
    suspend fun refreshInbox(slug: String) {
        if (!host.meets()) return
        if (inboxSlug != slug) resetInbox(slug)
        val generation = ++inboxGeneration
        val startedAt = now()
        when (val r = api.inbox(slug)) {
            is ApiResult.Ok -> {
                if (generation != inboxGeneration || inboxSlug != slug) return
                incoming = r.value.incoming
                outgoing = r.value.outgoing
                inboxLoaded = true
                for (m in incoming) {
                    m.from?.let { meetRefs[m.meetId] = it.ref }
                    rememberIncoming(m)
                }
                for (m in outgoing) m.to?.let { meetRefs[m.meetId] = it.ref }
                // The server's list decides now; a note made after this poll set out stays until the next.
                asked.entries.removeAll { it.value.at < startedAt }
                host.changed()
            }
            is ApiResult.Failed -> {
                if (generation != inboxGeneration || inboxSlug != slug) return
                val e = r.error
                e.retryAfterSeconds?.let { notBefore = max(notBefore, now() + it * 1000) }
                // No device, or no profile at this conference any more: there is nothing to ask about.
                if (e.kind == PeopleError.Kind.NoDevice || e.kind == PeopleError.Kind.ProfileRequired) {
                    incoming = emptyList()
                    outgoing = emptyList()
                    inboxLoaded = true
                    asked.clear()
                    host.changed()
                }
            }
        }
    }

    /** Removes one request from the local inbox right away, before the next poll confirms it. */
    fun dropIncoming(slug: String, meetId: String) {
        if (inboxSlug != slug) return
        incoming = incoming.filter { it.meetId != meetId }
        asked.entries.removeAll { it.value.meetId == meetId }
        host.changed()
    }

    fun setIncomingState(slug: String, meetId: String, state: MeetState) {
        if (inboxSlug != slug) return
        incoming = incoming.map { if (it.meetId == meetId) it.copy(state = state) else it }
        asked.entries.removeAll { it.value.meetId == meetId }
        host.changed()
    }

    // ---------------------------------------------------------------------------------------------
    // The poll

    /** The inbox screen is showing: the inbox is polled whatever else holds. */
    fun setInboxScreen(visible: Boolean) {
        inboxScreen = visible
    }

    /**
     * Starts or stops the poll for [slug] (null: none) to match what holds now: the app in the
     * foreground, meets offered, and presence on, an open request of ours or the inbox screen.
     */
    fun updatePoll(slug: String?) {
        val active = slug != null && host.foreground() && host.meets() &&
            (inboxScreen || host.presence(slug).on || outgoing(slug).any { it.state.isOpen } || asked.isNotEmpty())
        if (active && pollJob != null && pollSlug == slug) return
        if (!active) {
            pollJob?.cancel()
            pollJob = null
            pollSlug = null
            return
        }
        pollJob?.cancel()
        pollSlug = slug
        pollJob = scope.launch {
            var ticks = 0
            while (true) {
                delay(host.pace.pacedMs(INBOX_POLL_MS))
                // A Retry-After holds the next request back until it has passed.
                val wait = notBefore - now()
                if (wait > 0) delay(wait)
                if (host.foreground()) {
                    scope.launch { refreshInbox(slug!!) }
                    if (ticks % NUDGE_EVERY_TICKS == 0) scope.launch { nudgeTick(slug!!) }
                    ticks++
                }
            }
        }
    }

    fun stopPoll() {
        pollJob?.cancel()
        pollJob = null
        pollSlug = null
    }

    // ---------------------------------------------------------------------------------------------
    // Blocks

    fun blocks(slug: String): List<BlockedPerson> = store.record(slug).blocks

    fun isBlocked(slug: String, ref: String): Boolean = blocks(slug).any { it.ref == ref }

    suspend fun addBlock(slug: String, ref: String, displayName: String?) {
        store.update(slug) { r -> r.copy(blocks = r.blocks.filter { it.ref != ref } + BlockedPerson(ref, displayName?.take(60))) }
        // A blocked person's card is not found again either (a sheet re-created after the block).
        known = known - ref
        host.changed()
    }

    suspend fun removeBlock(slug: String, ref: String) {
        store.update(slug) { r -> r.copy(blocks = r.blocks.filter { it.ref != ref }) }
        host.changed()
    }

    /** Replaces the cached list with the server's, keeping the names this device knows where the server has none. */
    suspend fun mergeBlocks(slug: String, entries: List<BlockEntry>) {
        store.update(slug) { r ->
            val known = r.blocks.associate { it.ref to it.displayName }
            r.copy(blocks = entries.take(500).map { BlockedPerson(it.ref, it.displayName?.take(60) ?: known[it.ref]) })
        }
        host.changed()
    }

    // ---------------------------------------------------------------------------------------------
    // Watch list and people met

    fun watches(slug: String): List<Watch> = store.record(slug).watch

    fun isWatched(slug: String, ref: String): Boolean = watches(slug).any { it.ref == ref }

    /** Starts watching a person, or stops when they are already watched. Returns the new state. */
    suspend fun toggleWatch(slug: String, ref: String, displayName: String): Boolean {
        val on = !isWatched(slug, ref)
        store.update(slug) { r ->
            r.copy(
                watch = if (on) {
                    (r.watch + Watch(ref, displayName.take(60), Instant.fromEpochMilliseconds(now()).toString())).takeLast(WATCH_MAX)
                } else {
                    r.watch.filter { it.ref != ref }
                },
            )
        }
        host.changed()
        return on
    }

    suspend fun removeWatch(slug: String, ref: String) {
        store.update(slug) { r -> r.copy(watch = r.watch.filter { it.ref != ref }) }
        host.changed()
    }

    suspend fun addMet(slug: String, displayName: String, about: String?) {
        val person = MetPerson(displayName.take(60), (about ?: "").take(280), Instant.fromEpochMilliseconds(now()).toString())
        store.update(slug) { r -> r.copy(met = (r.met + person).takeLast(500)) }
        host.changed()
    }

    /**
     * Removes [person] from People I met: the first entry equal to it, so a second tap on the same
     * row removes nothing more, where a position would have removed the next person.
     */
    suspend fun removeMet(slug: String, person: MetPerson) {
        store.update(slug) { r ->
            val i = r.met.indexOf(person)
            if (i < 0) r else r.copy(met = r.met.filterIndexed { j, _ -> j != i })
        }
        host.changed()
    }

    // ---------------------------------------------------------------------------------------------
    // Nudges

    fun nudgesEnabled(slug: String): Boolean = store.record(slug).nudgesOn

    suspend fun setNudgesEnabled(slug: String, on: Boolean) {
        store.update(slug) { it.copy(nudgesOn = on) }
        if (!on && current?.slug == slug) current = null
        host.changed()
    }

    /** The local date of today in the device's time zone, the day nudges are counted by. */
    private fun today(): String = Instant.fromEpochMilliseconds(now()).toLocalDateTime(host.timeZone).date.toString()

    /**
     * True when [ref] was nudged about today at [slug]. In-app nudges and Bluetooth notifications
     * share this record (as nudges.ts and ble.ts share `caddie.nudged.v1`), so neither repeats the other.
     */
    fun wasNudgedToday(slug: String, ref: String): Boolean = store.record(slug).nudged[ref] == today()

    /** Records that [ref] was nudged about today at [slug]. */
    suspend fun recordNudge(slug: String, ref: String) {
        val day = today()
        // Older days are of no further use, so the map holds today's entries only.
        store.update(slug) { r -> r.copy(nudged = r.nudged.filterValues { it == day } + (ref to day)) }
    }

    /** The banner to show for [slug], or null. Nothing shows while presence or the setting is off. */
    fun currentNudge(slug: String): Nudge? {
        val n = current ?: return null
        if (n.slug != slug || !nudgesEnabled(slug) || !host.presence(slug).on) return null
        return n
    }

    fun dismissNudge() {
        current = null
        host.changed()
    }

    /** "See who": closes the banner and asks the People tab to show that person's card. */
    fun seeWho(nudge: Nudge) {
        reveal = nudge.slug to nudge.ref
        current = null
        host.changed()
    }

    /** Asks the People tab to land on [ref]'s card, as a tapped Bluetooth notification does. */
    fun requestReveal(slug: String, ref: String) {
        reveal = slug to ref
        host.changed()
    }

    fun pendingReveal(slug: String): String? = reveal?.takeIf { it.first == slug }?.second

    /** The reveal request was handled (the card was shown, or the person has left the list). */
    fun consumeReveal() {
        if (reveal != null) {
            reveal = null
            host.changed()
        }
    }

    /** Drops the banner, the reveal request and the in-memory state, for "Delete my profile". */
    fun resetNudges() {
        nudgeGeneration++
        current = null
        reveal = null
        host.changed()
    }

    /**
     * One `around_now` request while presence is on and nudges are wanted. The first specific match
     * in my zone not nudged today becomes the banner; else someone I watch who is around anywhere.
     * Errors are kept quiet: the next tick tries again. With [notify] (the app is not in the
     * foreground), a strong-match nudge also shows as a local notification with exactly the
     * banner's words, which never name the person.
     */
    suspend fun nudgeTick(slug: String, notify: Boolean = !host.foreground()) {
        if (!host.presenceOn()) return
        val presence = host.presence(slug)
        if (!presence.on || presence.zone == null) {
            if (current?.slug == slug) dismissNudge()
            return
        }
        if (!nudgesEnabled(slug) || !store.visibility(slug).openToMeet) return
        // One banner at a time: while one waits to be read, nothing else is asked for.
        if (current?.slug == slug) return
        val generation = ++nudgeGeneration
        val r = api.matches(
            MatchesRequest(event = slug, interestedTalkIds = Opt.Of(emptyList()), whenNow = Opt.Of(MatchWhen.AroundNow), size = Opt.Of(MATCH_PAGE)),
        )
        val res = (r as? ApiResult.Ok)?.value ?: return
        if (generation != nudgeGeneration) return
        val now = host.presence(slug)
        val zone = now.zone
        if (!now.on || zone == null || current != null || !nudgesEnabled(slug)) return
        val results = res.results.filter { !isBlocked(slug, it.ref) && !wasNudgedToday(slug, it.ref) }
        results.forEach { rememberPerson(it) }
        // 1. A specific match in my own zone.
        for (p in results) {
            if (p.broad || !p.around || p.zone == null || p.zone != zone) continue
            val evidence = PeopleText.evidenceFor(p) ?: continue
            show(slug, p, Nudge(slug, p.ref, zone, PeopleText.nudgeText(evidence, zone), watched = false), notify)
            return
        }
        // 2. Someone I'm watching, in any zone, broad or not. The watch itself stays: they decide.
        val watched = watches(slug).map { it.ref }.toSet()
        for (p in results) {
            val theirs = p.zone
            if (p.ref !in watched || !p.around || theirs == null) continue
            show(slug, p, Nudge(slug, p.ref, theirs, PeopleText.watchText(p.displayName, theirs), watched = true), notify = false)
            return
        }
    }

    private suspend fun show(slug: String, p: Person, nudge: Nudge, notify: Boolean) {
        recordNudge(slug, p.ref)
        current = nudge
        host.changed()
        if (notify) host.notifier.show(NUDGE_NOTIFICATION_ID, Demo.notificationTitle(NOTIFICATION_TITLE, host.demo(slug)), nudge.text, NUDGE_DEEP_LINK)
    }

    companion object {
        /** How many people [knownPerson] keeps: a few pages of results. */
        const val KNOWN_PEOPLE = 300

        /** The inbox poll at pace 1; the real wait is stretched by the pace the API reports. */
        const val INBOX_POLL_MS = 45_000L

        /** The nudge check runs on every third inbox tick, about every 2 minutes at pace 1. */
        const val NUDGE_EVERY_TICKS = 3

        /** An ask runs out 15 minutes after it was made, so a note of one is never kept longer. */
        const val ASKED_MAX_MS = 15 * 60_000L

        const val WATCH_MAX = 200

        /** A page of people, the server's largest. */
        const val MATCH_PAGE = 20

        const val NOTIFICATION_TITLE = "Conference Caddie"
        const val NUDGE_NOTIFICATION_ID = "caddie-nudge"
        const val NUDGE_DEEP_LINK = "caddie://people?around=1"
    }
}
