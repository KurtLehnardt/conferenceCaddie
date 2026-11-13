package app.conferencecaddie.shared.ble

import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.Notifier
import app.conferencecaddie.shared.bundle.IsoTime
import app.conferencecaddie.shared.people.ApiResult
import app.conferencecaddie.shared.people.BleOutcome
import app.conferencecaddie.shared.people.BleProblem
import app.conferencecaddie.shared.people.BleView
import app.conferencecaddie.shared.people.ConnectRuntime
import app.conferencecaddie.shared.people.NearbyPerson
import app.conferencecaddie.shared.people.PeopleApi
import app.conferencecaddie.shared.people.PeopleError
import app.conferencecaddie.shared.people.PeopleStore
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.shared.people.Presence
import app.conferencecaddie.shared.people.PresenceMode
import app.conferencecaddie.shared.people.PresencePutResponse
import app.conferencecaddie.shared.people.Sighting
import app.conferencecaddie.shared.people.SightingsRequest
import kotlin.concurrent.Volatile
import kotlin.math.max
import kotlin.math.min
import kotlin.time.Clock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** What the people controller provides to [BleRuntime]: the rest of the people runtime. */
internal interface BleHost {
    val clock: Clock
    val notifier: Notifier

    /** The normalised base of this session's backend, part of every key alias. */
    val backendBase: String

    /** The changes of state the screens should see. */
    fun changed()

    /** True when the backend offers derived-v1 Bluetooth with presence (the radio aside). */
    fun bleOffered(): Boolean

    /** The backend's Bluetooth settings (`ble.near_rssi`, `ble.sightings_min_interval_s`). */
    fun bleSettings(): Capabilities.Ble

    /** Presence of [slug] as it stands now. */
    fun presence(slug: String): Presence

    /** The presence write with `ble` that repeats the current presence; null when presence is off by its turn. */
    suspend fun writePresenceBle(slug: String, ble: Boolean): ApiResult<PresencePutResponse>?

    /** Turns presence off at [slug], on the device at once and then on the server with a delete. */
    suspend fun endPresence(slug: String)

    fun isBlocked(slug: String, ref: String): Boolean

    /** True when [ref] was already nudged about today, in the app or by Bluetooth. */
    fun nudgedToday(slug: String, ref: String): Boolean

    suspend fun recordNudge(slug: String, ref: String)

    /** Asks the People tab to land on [ref]'s card. */
    fun reveal(slug: String, ref: String)

    /** A message for a toast ([app.conferencecaddie.shared.people.PeopleUiState.notice]). */
    fun notice(message: String)

    /** Bluetooth started or stopped at [slug], so presence's background rule can follow. */
    fun bluetoothChanged(slug: String)
}

/**
 * Bluetooth proximity for one backend (docs/contracts/ble-tokens.md; web/src/people/ble.ts ported to
 * derived tokens): turning it on and off, the radio's payload, sightings batching, re-keying and the
 * nearby notifications. The platform supplies only the radio and the key store ([BlePlatform]); a
 * null platform means no Bluetooth on this device.
 *
 * One conference at a time runs: turning it on at another conference stops the first, telling the
 * server. The key arrives once in the answer to a presence write with `ble: true` and goes straight
 * into the key store; its text is dropped and the bytes zeroed. The radio asks [Run.source] for the
 * payload whenever it advertises or answers a read, so tokens change at every window with no network
 * call; this runtime also tells the radio at every window start.
 *
 * Sightings are reported at most once per `ble.sightings_min_interval_s`, no later than that after
 * the first of them was heard, never once five minutes have passed since a token was last heard,
 * never this phone's own tokens or ones already reported in the window, at most the 50 strongest,
 * and only at or above `ble.near_rssi`. A report the server refuses or does not answer waits before
 * the next one (backoff, Retry-After within an interval and an hour).
 * The answer's strong matches become at most one notification per answer, three an hour and one per
 * person per day (shared with the in-app nudges).
 *
 * Everything runs on the controller's serial context; radio events hop onto it. Nothing here logs.
 */
internal class BleRuntime(
    private val platform: BlePlatform?,
    private val store: PeopleStore,
    private val api: PeopleApi,
    private val scope: CoroutineScope,
    private val host: BleHost,
) {
    private fun now() = host.clock.now().toEpochMilliseconds()

    private fun alias(slug: String) = BleProtocol.keyAlias(host.backendBase, slug)

    /**
     * One token waiting to be reported: the strongest RSSI heard, when it was first heard (the report
     * goes no later than an interval after that) and when it was last heard (it is dropped five
     * minutes after that, so a token heard all along is not lost to a report that had to wait).
     */
    private class Heard(val rssi: Int, val firstAt: Long, val lastAt: Long) {
        fun merge(other: Heard) = Heard(max(rssi, other.rssi), min(firstAt, other.firstAt), max(lastAt, other.lastAt))
    }

    /** The radio's session at one conference, from its start to its stop. */
    private inner class Run(val slug: String, val alias: String, var config: BleRadioConfig, val intervalMs: Long) : BleRadioEvents {
        val source = Source(platform!!.keys, alias, host.clock)
        val pending = LinkedHashMap<String, Heard>()
        val resolved = HashSet<String>()
        var resolvedWindow = -1L
        var lastSentAt = 0L
        var backoffUntil = 0L
        var backoffMs = 0L
        var sending = false
        var rekeyDue = false
        var awakeUntil = -1L
        var flushJob: Job? = null
        var windowJob: Job? = null
        var untilJob: Job? = null
        var ownWindow = -1L
        var ownVersion = -1
        var own: Set<String> = emptySet()

        override fun onHeard(payload: ByteArray, rssi: Int, atEpochMillis: Long) {
            val bytes = payload.copyOf()
            scope.launch { heard(this@Run, bytes, rssi, atEpochMillis) }
        }

        override fun onStopped(reason: BleStopReason) {
            scope.launch { radioStopped(this@Run, reason) }
        }

        // The platform woke the app at the time keepAwakeUntil named, or later. The report timer
        // runs on the monotonic clock, which may have stood still while the phone slept, so the
        // schedule is worked out again from the wall clock: a report that is due (or overdue) goes
        // now, one that is not yet due keeps its time, and one already being sent is left alone.
        override fun onReportDue() {
            scope.launch { reportDue(this@Run) }
        }
    }

    /**
     * The payload of the window of the phone's clock now, derived from the key in the store and
     * cached per window and key. Safe from any thread: a radio calls it from its own callbacks.
     */
    internal class Source(private val keys: BleKeyStore, private val alias: String, private val clock: Clock) : BlePayloadSource {
        private class Cached(val window: Long, val version: Int, val payload: ByteArray)

        /** Moves on whenever the key under the alias is replaced, after the new key is stored. */
        @Volatile
        var keyVersion = 0

        /** Set once the run has stopped: there is nothing to serve any more. */
        @Volatile
        var closed = false

        @Volatile
        private var cached: Cached? = null

        override fun payloadNow(): ByteArray? {
            if (closed) return null
            // A clock set before 1970 has no window; a radio callback gets nothing rather than a throw.
            val nowMs = clock.now().toEpochMilliseconds()
            if (nowMs < 0) return null
            val w = BleProtocol.windowAtMillis(nowMs)
            val version = keyVersion
            cached?.let { if (it.window == w && it.version == version) return it.payload.copyOf() }
            val token = tokenOf(w) ?: return null
            val payload = BleProtocol.encodePayload(token)
            cached = Cached(w, version, payload)
            return payload.copyOf()
        }

        /** This phone's token of window [w], or null without a key (or when the key store fails, which a radio callback must never see). */
        fun tokenOf(w: Long): ByteArray? = keys.hmacOrNull(alias, BleProtocol.tokenMessage(w))?.let { BleProtocol.tokenOf(it) }
    }

    private var run: Run? = null
    private var startingSlug: String? = null
    private val problems = HashMap<String, Pair<BleProblem, String?>>()
    private var notificationsAllowed = true
    private val turningOn = Mutex()

    // Every stop moves these on, so a turn-on still under way at that conference gives up.
    private val stopsBySlug = HashMap<String, Int>()
    private var stopsEverywhere = 0

    // Turn-offs the person asked for, per conference: a turn-on they cut short has nothing to explain.
    private val offsBySlug = HashMap<String, Int>()

    private fun stopMark(slug: String): Pair<Int, Int> = stopsEverywhere to (stopsBySlug[slug] ?: 0)

    // ---------------------------------------------------------------------------------------------
    // State for the screens

    /** True when the row shows: the backend offers derived-v1 with presence, and this device has a radio that can take part. */
    fun available(): Boolean = host.bleOffered() && platform?.radio?.supported == true

    /** True while the radio runs for conference [slug]. */
    fun running(slug: String): Boolean = run?.slug == slug

    /** What the screens show for conference [slug]. */
    fun view(slug: String): BleView {
        val record = store.record(slug).ble
        val problem = problems[slug]
        return BleView(
            available = available(),
            on = record.on && running(slug),
            starting = startingSlug == slug,
            noticeSeen = record.noticeSeen,
            permission = platform?.radio?.permissionKind ?: BlePermissionKind.NearbyDevices,
            problem = problem?.first,
            message = problem?.second,
            notificationsAllowed = notificationsAllowed,
            hiddenFromIphones = platform?.radio?.hiddenFromIphones ?: false,
        )
    }

    // ---------------------------------------------------------------------------------------------
    // Turning it on and off

    /**
     * Turns Bluetooth on at [slug] (web ble.ts `startBle`): availability, presence, the permission,
     * the radio's state, notifications, the presence write with `ble: true` that repeats presence,
     * the key into the store, the device record and the radio, in that order. Any problem from an
     * earlier attempt is cleared first.
     */
    suspend fun turnOn(slug: String): BleOutcome = turningOn.withLock {
        if (running(slug) && store.record(slug).ble.on) return@withLock BleOutcome.On
        problems.remove(slug)
        startingSlug = slug
        host.changed()
        try {
            start(slug)
        } finally {
            startingSlug = null
            host.changed()
        }
    }

    private fun refuse(slug: String, problem: BleProblem, message: String? = null): BleOutcome {
        val words = message ?: PeopleText.bleProblemMessage(problem, platform?.radio?.permissionKind ?: BlePermissionKind.NearbyDevices)
        problems[slug] = problem to words
        return BleOutcome.Problem(problem, words)
    }

    private fun presenceLive(slug: String): Boolean = host.presence(slug).let { it.on && it.zone != null }

    private suspend fun start(slug: String): BleOutcome {
        val platform = platform
        if (platform == null || !available()) return refuse(slug, BleProblem.Unsupported)
        val radio = platform.radio
        val keys = platform.keys
        // A delete covering the conference is the stronger reason: presence cannot come back until it finishes.
        if (store.deleteCovers(slug)) return refuse(slug, BleProblem.Failed, PeopleError.DELETE_UNFINISHED_MESSAGE)
        if (!presenceLive(slug)) return refuse(slug, BleProblem.NeedsPresence)
        val mark = stopMark(slug)
        val offs = offsBySlug[slug] ?: 0

        // Presence ended, or Bluetooth was turned off or stopped here, while this waited: the
        // attempt ends there. The person turning it off needs no explanation; any other stop (a
        // delete, a backend switch, the capabilities) leaves its words under the switch, so the
        // setup panel that is still open says why nothing started.
        fun abandoned(): BleOutcome = when {
            !presenceLive(slug) -> refuse(slug, BleProblem.NeedsPresence)
            (offsBySlug[slug] ?: 0) != offs -> BleOutcome.Problem(BleProblem.Failed, PeopleText.BLE_START_FAILED)
            store.deleteCovers(slug) -> refuse(slug, BleProblem.Failed, PeopleError.DELETE_UNFINISHED_MESSAGE)
            else -> refuse(slug, BleProblem.Failed, PeopleText.BLE_START_FAILED)
        }

        when (radio.access()) {
            BleAccess.Granted -> Unit
            // Refused for good: the prompt would not show, so only the settings can help.
            BleAccess.Blocked -> return refuse(slug, BleProblem.PermissionBlocked)
            BleAccess.NotAsked, BleAccess.Denied -> when (radio.requestAccess()) {
                BleAccess.Granted -> Unit
                BleAccess.Blocked -> return refuse(slug, BleProblem.PermissionBlocked)
                BleAccess.Denied, BleAccess.NotAsked -> return refuse(slug, BleProblem.PermissionDenied)
            }
        }
        when (radio.state()) {
            // Unknown: iOS reports its state a moment after the managers start; a radio that turns
            // out not to work reports it through onStopped.
            BleRadioState.Ready, BleRadioState.Unknown -> Unit
            BleRadioState.PoweredOff -> return refuse(slug, BleProblem.BluetoothOff)
            BleRadioState.LocationOff -> return refuse(slug, BleProblem.LocationOff)
            BleRadioState.Unauthorized -> return refuse(slug, BleProblem.PermissionBlocked)
            BleRadioState.Unsupported -> return refuse(slug, BleProblem.Unsupported)
        }
        // Without notifications a nearby match cannot be announced, but the rest still works.
        notificationsAllowed = host.notifier.requestPermission()
        host.changed()
        if (stopMark(slug) != mark || !presenceLive(slug)) return abandoned()

        // One conference at a time: the one running elsewhere stops, and its server is told.
        run?.takeIf { it.slug != slug }?.let { turnOffAt(it.slug) }
        val markBeforeWrite = stopMark(slug)

        val res = when (val r = host.writePresenceBle(slug, true)) {
            null -> return refuse(slug, BleProblem.NeedsPresence)
            is ApiResult.Failed -> return when {
                // presence_not_active: presence had already ended on the server, and the refused
                // `until: "keep"` write ended it here too.
                r.error.kind == PeopleError.Kind.PresenceRequired || r.error.kind == PeopleError.Kind.PresenceNotActive -> refuse(slug, BleProblem.NeedsPresence)
                r.error.kind == PeopleError.Kind.DeleteUnfinished -> refuse(slug, BleProblem.Failed, PeopleError.DELETE_UNFINISHED_MESSAGE)
                else -> refuse(slug, BleProblem.Failed, PeopleText.presenceProblem(r.error))
            }
            is ApiResult.Ok -> r.value
        }
        // Stopped while the write was under way: the write queued behind this one (the presence
        // delete, or `ble: false`) has the last word, and no key is kept.
        if (stopMark(slug) != markBeforeWrite || !presenceLive(slug)) return abandoned()
        val keyId = res.bleKeyId
        val key = BleProtocol.decodeKey(res.bleKey)
        // A server-rotate or older backend answers without a key this app can use.
        if (key == null || keyId == null || !BleProtocol.isKeyId(keyId)) return refuse(slug, BleProblem.Failed, PeopleText.BLE_START_FAILED)
        val alias = alias(slug)
        val stored = keys.store(alias, key, keyId)
        // Stopped while the key went into the store (the platform's put waits for its own thread):
        // the stop removed the key before this one landed, so it goes again.
        if (stopMark(slug) != markBeforeWrite || !presenceLive(slug)) {
            if (run?.alias != alias) keys.removeQuietly(alias)
            return abandoned()
        }
        if (!stored) {
            keys.removeQuietly(alias)
            return refuse(slug, BleProblem.Failed, PeopleText.BLE_START_FAILED)
        }
        store.update(slug) { it.copy(ble = it.ble.copy(on = true, noticeSeen = true, keyId = keyId, rekeyW = null)) }
        problems.remove(slug)
        startRun(slug, alias)
        return BleOutcome.On
    }

    /**
     * Turns Bluetooth off at [slug] at the person's request (the switch, or Stop in the ongoing
     * notification): the radio, its timers and the key go at once, then, while presence is still
     * on, a presence write with `ble: false` tells the server (in the presence write queue).
     */
    suspend fun turnOff(slug: String, undoOnFailure: Boolean = false) {
        if (undoOnFailure) {
            // The record first, before anything stops: a switch whose record cannot be written
            // leaves Bluetooth as it was (the radio, the key, a start under way, the problem shown)
            // and nothing is sent; the exception tells the caller.
            val wasOn = running(slug) || store.record(slug).ble.on || startingSlug == slug
            store.update(slug, undoOnFailure = true) { it.copy(ble = it.ble.copy(on = false, keyId = null, rekeyW = null)) }
            offsBySlug[slug] = (offsBySlug[slug] ?: 0) + 1
            problems.remove(slug)
            stop(slug)
            if (wasOn) host.writePresenceBle(slug, false)
            return
        }
        offsBySlug[slug] = (offsBySlug[slug] ?: 0) + 1
        problems.remove(slug)
        turnOffAt(slug)
    }

    /**
     * The capabilities changed with the session unchanged. When they no longer offer Bluetooth
     * (derived-v1 or presence withdrawn, or people features off), it stops at once on the device
     * wherever it runs or is starting, since its switch is gone and nothing else would stop it (iOS
     * has no Stop of its own), and then, while presence is on, a presence write with `ble: false`
     * tells the server (best effort, in the presence write queue, after this returns).
     */
    suspend fun offerChanged() {
        if (host.bleOffered()) return
        val slugs = (store.slugsWhere { it.ble.on } + listOfNotNull(run?.slug, startingSlug)).distinct()
        for (s in slugs) {
            problems.remove(s)
            stop(s)
            scope.launch { host.writePresenceBle(s, false) }
        }
    }

    private suspend fun turnOffAt(slug: String) {
        val wasOn = running(slug) || store.record(slug).ble.on || startingSlug == slug
        stop(slug)
        if (!wasOn) return
        // Best effort: the session ends with presence anyway.
        host.writePresenceBle(slug, false)
    }

    /**
     * Stops Bluetooth at [slug], or at every conference of this backend with null, on the device
     * only: the radio, its timers, the pending sightings and the keys go, and the record says off.
     * For presence ending, visibility off, deletes and a backend switch, which end the server's
     * session themselves. [problem] and [message] say why, under the switch.
     */
    suspend fun stop(slug: String?, problem: BleProblem? = null, message: String? = null) {
        if (slug == null) stopsEverywhere++ else stopsBySlug[slug] = (stopsBySlug[slug] ?: 0) + 1
        val r = run
        if (r != null && (slug == null || r.slug == slug)) endRun(r)
        val keys = platform?.keys
        val slugs = if (slug == null) (store.slugs + listOfNotNull(r?.slug)) else setOf(slug)
        for (s in slugs) {
            keys?.removeQuietly(alias(s))
            val rec = store.record(s).ble
            if (rec.on || rec.keyId != null || rec.rekeyW != null) store.update(s) { it.copy(ble = it.ble.copy(on = false, keyId = null, rekeyW = null)) }
        }
        if (slug != null && problem != null) problems[slug] = problem to (message ?: PeopleText.bleProblemMessage(problem, platform?.radio?.permissionKind ?: BlePermissionKind.NearbyDevices))
        if (slug == null) problems.clear()
        if (r != null && (slug == null || r.slug == slug)) host.bluetoothChanged(r.slug)
        host.changed()
    }

    private suspend fun endRun(r: Run) {
        run = null
        r.source.closed = true
        // A report under way is cancelled with its job, unless the report itself is what stops
        // the run (a 403, a second re-key in the window): cancelling it then would cut this stop short.
        val self = currentCoroutineContext()[Job]
        r.flushJob?.takeIf { it !== self }?.cancel()
        r.windowJob?.cancel()
        r.untilJob?.cancel()
        r.flushJob = null
        r.windowJob = null
        r.untilJob = null
        r.pending.clear()
        r.resolved.clear()
        platform?.radio?.stop()
    }

    // ---------------------------------------------------------------------------------------------
    // Following presence, and restoring after a restart

    /**
     * Presence of [slug] changed on the device. Ended: Bluetooth stops there on the device only (the
     * presence delete or the server already ended the session). Still on with a new `until`: the
     * radio is started again with it, which switches a running radio's deadline. A write without
     * `ble` (a zone change, an extension, a position) keeps the session and the key.
     */
    suspend fun presenceChanged(slug: String) {
        val r = run?.takeIf { it.slug == slug }
        if (!presenceLive(slug)) {
            if (r != null || store.record(slug).ble.on || startingSlug == slug) stop(slug)
            return
        }
        if (r == null) return
        val until = untilOf(slug) ?: return
        if (until == r.config.untilEpochMillis) return
        r.config = r.config.copy(untilEpochMillis = until)
        scheduleUntil(r)
        platform?.radio?.start(r.config, r.source, r)
    }

    /**
     * Picks up Bluetooth where the record says it is on, when this backend's session is set up: at
     * the app's start, after the system restarted Android's service or relaunched the app for an iOS
     * state restoration, and after a backend switch back. It resumes only when it is still offered,
     * presence is live, the key is still in the store and names the stored key id, the permission is
     * granted and the radio can run; otherwise the record says off and the key goes, with no server
     * call. One conference at most resumes; when none does, the radio is stopped all the same.
     *
     * When the platform says the person stopped the whole app since the radio last ran
     * ([BleRadio.takeUserStoppedApp], asked at every restore since asking clears it), nothing
     * resumes: every conference whose record says on is turned off as the person's own off, on the
     * device at once and then on the server (best effort, in the presence write queue, after this
     * returns). Hour-mode presence ends with it, with a delete: Bluetooth was what kept it on in a
     * pocket, and a person who stopped the whole app is not counting on it any more. Day-mode
     * presence stays on, since backgrounding is its normal state, and gets `ble: false` instead.
     * Presence that has already ended sends nothing.
     */
    suspend fun restore() {
        // The radio is one per process and keeps one access listener, while each backend has its own
        // runtime: the runtime of the backend now selected takes it over here, at every session
        // switch, so a late answer to the prompt reaches the backend whose switch shows the refusal.
        platform?.radio?.watchAccess { scope.launch { accessChanged() } }
        val slugs = store.slugsWhere { it.ble.on }
        if (platform?.radio?.takeUserStoppedApp() == true) {
            for (s in slugs) {
                offsBySlug[s] = (offsBySlug[s] ?: 0) + 1
                problems.remove(s)
                val hourPresence = host.presence(s).let { it.on && it.mode == PresenceMode.Hour }
                stop(s)
                scope.launch { if (hourPresence) host.endPresence(s) else host.writePresenceBle(s, false) }
            }
            platform.radio.stop()
            return
        }
        val resume = slugs.firstOrNull { canResume(it) }
        for (s in slugs) if (s != resume) stop(s)
        if (resume != null && run == null) startRun(resume, alias(resume))
        // Nothing resumed: a radio the system restarted on its own (Android's sticky service, an
        // iOS state restoration) would otherwise keep advertising a payload nobody serves.
        if (run == null) {
            if (resume != null) stop(resume)
            platform?.radio?.stop()
        }
    }

    private fun canResume(slug: String): Boolean {
        val platform = platform ?: return false
        if (!available() || !presenceLive(slug) || store.deleteCovers(slug)) return false
        val mac = platform.keys.hmacOrNull(alias(slug), BleProtocol.keyIdMessage()) ?: return false
        if (BleProtocol.keyIdOf(mac) != store.record(slug).ble.keyId) return false
        if (platform.radio.access() != BleAccess.Granted) return false
        return when (platform.radio.state()) {
            BleRadioState.Ready, BleRadioState.Unknown -> true
            BleRadioState.PoweredOff, BleRadioState.LocationOff, BleRadioState.Unauthorized, BleRadioState.Unsupported -> false
        }
    }

    private fun untilOf(slug: String): Long? = host.presence(slug).until?.let { IsoTime.epochMillis(it) }

    /**
     * The platform's permission changed outside a turn-on ([BleRadio.watchAccess]): on iOS, the
     * person answered the prompt after the turn-on had stopped waiting and counted it as refused.
     * A refusal left under the switch follows the answer: allowed clears it (the switch can be
     * turned on again at once), refused for good makes it a block. Nothing starts by itself.
     */
    private fun accessChanged() {
        val access = platform?.radio?.access() ?: return
        var changed = false
        for ((slug, p) in problems.entries.toList()) {
            val problem = p.first
            if (problem != BleProblem.PermissionDenied && problem != BleProblem.PermissionBlocked) continue
            when {
                access == BleAccess.Granted -> problems.remove(slug)
                access == BleAccess.Blocked && problem == BleProblem.PermissionDenied -> refuse(slug, BleProblem.PermissionBlocked)
                else -> continue
            }
            changed = true
        }
        if (changed) host.changed()
    }

    private fun startRun(slug: String, alias: String) {
        val radio = platform?.radio ?: return
        val settings = host.bleSettings()
        val until = untilOf(slug) ?: return
        val r = Run(slug, alias, BleRadioConfig(nearRssi = settings.nearRssi, untilEpochMillis = until), settings.sightingsMinIntervalSeconds * 1000L)
        run = r
        r.windowJob = scope.launch {
            while (true) {
                val now = now()
                delay(BleProtocol.windowStartMillis(BleProtocol.windowAtMillis(now) + 1) - now)
                if (run !== r) return@launch
                radio.refresh()
                rollWindow(r, BleProtocol.windowAtMillis(now()))
                // The key went from the store while it ran (a Keystore that lost it): the radio has
                // nothing to send, so a new key is fetched (once per window, as any re-key) through
                // the reports' loop.
                if (r.source.payloadNow() == null && !r.rekeyDue) {
                    r.rekeyDue = true
                    scheduleFlush(r)
                }
            }
        }
        scheduleUntil(r)
        radio.start(r.config, r.source, r)
        host.bluetoothChanged(slug)
        host.changed()
    }

    // The radio stops by itself at presence's until; this runtime does too, wherever the selected
    // conference is, since presence's own timers follow the selected conference only.
    private fun scheduleUntil(r: Run) {
        r.untilJob?.cancel()
        r.untilJob = scope.launch {
            delay(max(0, r.config.untilEpochMillis - now()))
            r.untilJob = null
            if (run === r && !presenceLive(r.slug)) stop(r.slug)
        }
    }

    private suspend fun radioStopped(r: Run, reason: BleStopReason) {
        if (run !== r) return
        when (reason) {
            BleStopReason.User -> turnOff(r.slug)
            BleStopReason.BluetoothOff -> {
                stop(r.slug, BleProblem.BluetoothOff)
                host.notice(PeopleText.BLE_STOPPED_BLUETOOTH_OFF)
            }
            BleStopReason.LocationOff -> {
                stop(r.slug, BleProblem.LocationOff)
                host.notice(PeopleText.BLE_LOCATION_OFF)
            }
            BleStopReason.PermissionLost -> stop(r.slug, BleProblem.PermissionBlocked)
            BleStopReason.AdvertiseFailed, BleStopReason.Unsupported -> {
                stop(r.slug, BleProblem.Unsupported, PeopleText.BLE_SEND_FAILED)
                host.notice(PeopleText.BLE_SEND_FAILED)
            }
            BleStopReason.System -> stop(r.slug)
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Sightings

    // A new window: the tokens reported in the last one may be heard and reported again.
    private fun rollWindow(r: Run, w: Long) {
        if (r.resolvedWindow == w) return
        r.resolvedWindow = w
        r.resolved.clear()
    }

    // This phone's own tokens of the windows the server accepts now, so its own payload heard back
    // (a second radio, a reflection) is never reported.
    private fun ownTokens(r: Run, w: Long): Set<String> {
        val version = r.source.keyVersion
        if (r.ownWindow != w || r.ownVersion != version) {
            r.own = (w - 1..w + 1).mapNotNull { r.source.tokenOf(it)?.let { t -> BleProtocol.encodeToken(t) } }.toSet()
            r.ownWindow = w
            r.ownVersion = version
        }
        return r.own
    }

    private fun heard(r: Run, payload: ByteArray, rssi: Int, at: Long) {
        if (run !== r) return
        val token = BleProtocol.decodePayload(payload) ?: return
        // Above 20 dBm is no reading at all (Android reports 127 when it has none).
        if (rssi < r.config.nearRssi || rssi > RSSI_MAX) return
        val now = now()
        val heardAt = min(at, now)
        if (now - heardAt > BleProtocol.SIGHTING_MAX_AGE_MS) return
        val w = BleProtocol.windowAtMillis(now)
        rollWindow(r, w)
        val text = token.text
        if (text in ownTokens(r, w) || text in r.resolved) return
        val heardNow = Heard(rssi, heardAt, heardAt)
        r.pending[text] = r.pending[text]?.merge(heardNow) ?: heardNow
        scheduleFlush(r)
    }

    // The next report goes at the latest of: one interval after the last, the first sighting heard
    // (no later than an interval after it), and the end of any backoff. A platform that suspends the
    // app soon after a Bluetooth event is asked to keep it running until then.
    private fun scheduleFlush(r: Run) {
        if (run !== r || r.sending) return
        r.flushJob?.cancel()
        r.flushJob = null
        if (r.pending.isEmpty() && !r.rekeyDue) return
        val earliest = r.pending.values.minOfOrNull { it.firstAt } ?: 0L
        val at = maxOf(r.lastSentAt + r.intervalMs, earliest, r.backoffUntil)
        if (r.pending.isNotEmpty() && at != r.awakeUntil) {
            r.awakeUntil = at
            platform?.radio?.keepAwakeUntil(at)
        }
        // The job stays the run's flushJob while its report is under way, so a stop cancels the
        // report too; flush lets go of it once the report is over.
        r.flushJob = scope.launch {
            delay(max(0, at - now()))
            flush(r)
        }
    }

    // A wake from the platform (BleRadioEvents.onReportDue): the next report is scheduled again from
    // the wall clock now, which sends it at once when it is due. scheduleFlush leaves a report that
    // is being sent alone and keeps the interval and any backoff.
    private fun reportDue(r: Run) {
        if (run !== r) return
        scheduleFlush(r)
    }

    // Whatever the report runs into (an exception from the records or a notification included),
    // the next one is scheduled; a cancellation still ends it.
    private suspend fun flush(r: Run) {
        if (run !== r || r.sending) return
        r.sending = true
        try {
            flushNow(r)
        } finally {
            r.sending = false
            // This report is over: its job is no longer the one to cancel, and must not be
            // cancelled by the scheduling of the next.
            if (r.flushJob === currentCoroutineContext()[Job]) r.flushJob = null
            scheduleFlush(r)
        }
    }

    private suspend fun flushNow(r: Run) {
        if (!presenceLive(r.slug)) {
            stop(r.slug)
            return
        }
        // A re-key whose write failed is tried again first.
        if (r.rekeyDue) {
            rekey(r)
            if (run !== r) return
        }
        val now = now()
        val w = BleProtocol.windowAtMillis(now)
        rollWindow(r, w)
        r.pending.entries.removeAll { now - it.value.lastAt > BleProtocol.SIGHTING_MAX_AGE_MS || it.key in r.resolved }
        if (r.pending.isEmpty() || now < r.lastSentAt + r.intervalMs || now < r.backoffUntil) return
        val batch = r.pending.entries.sortedByDescending { it.value.rssi }.take(BleProtocol.MAX_SIGHTINGS).map { it.key to it.value }
        for ((token, _) in batch) r.pending.remove(token)
        r.lastSentAt = now
        val res = api.sightings(SightingsRequest(r.slug, batch.map { (token, h) -> Sighting(token, h.rssi.coerceAtLeast(RSSI_MIN)) }))
        if (run !== r) return
        when (res) {
            is ApiResult.Ok -> {
                r.backoffMs = 0
                r.backoffUntil = 0
                if (BleProtocol.windowAtMillis(now()) == w) r.resolved += batch.map { it.first }
                val keyId = res.value.bleKeyId
                // Another key id, or none (a session the backend does not resolve as derived-v1):
                // this phone's tokens resolve to nobody until it has a new key.
                if (keyId == null || keyId != store.record(r.slug).ble.keyId) {
                    rekey(r)
                    if (run !== r) return
                }
                notifyNearby(r.slug, res.value.nearby)
            }
            is ApiResult.Failed -> {
                val e = res.error
                when {
                    e.kind == PeopleError.Kind.BleRekey -> {
                        putBack(r, batch)
                        rekey(r)
                    }
                    // ble_required, profile_required or any other refusal: the server holds no live
                    // session for this phone, so it stops here without another request.
                    e.status == 403 -> stop(r.slug)
                    e.status == 429 || e.noAnswer || e.status >= 500 || e.kind == PeopleError.Kind.BadResponse -> {
                        putBack(r, batch)
                        backOff(r, e)
                    }
                    // Any other 4xx (a 404 from a server without the route, say) refused this batch
                    // as it was: it is not sent again, and the next report waits as after a failure,
                    // so a server that keeps refusing is not asked at every interval.
                    else -> backOff(r, e)
                }
            }
        }
    }

    // The wait before the next request after one that failed: after a 429, Retry-After (or the
    // interval stretched by the API's pace), at least the interval and at most an hour; otherwise the
    // interval, then twice as long each time, at most five minutes. A request that goes through
    // resets it.
    private fun backOff(r: Run, e: PeopleError) {
        if (e.status == 429) {
            val wait = e.retryAfterSeconds?.let { min(it, RETRY_AFTER_MAX_MS / 1000) * 1000 } ?: api.pace.pacedMs(r.intervalMs)
            r.backoffUntil = now() + max(r.intervalMs, min(wait, RETRY_AFTER_MAX_MS))
            return
        }
        r.backoffMs = if (r.backoffMs == 0L) r.intervalMs else min(r.backoffMs * 2, BACKOFF_MAX_MS)
        r.backoffUntil = now() + r.backoffMs
    }

    // Sightings of a report that did not go through wait for the next one (and still age out).
    private fun putBack(r: Run, batch: List<Pair<String, Heard>>) {
        for ((token, h) in batch) r.pending[token] = r.pending[token]?.merge(h) ?: h
    }

    // ---------------------------------------------------------------------------------------------
    // Re-keying (docs/contracts/ble-tokens.md, Re-keying)

    /**
     * Gets a new key with a presence write (`ble: true`) that repeats presence in full, only while
     * presence is live and Bluetooth is on, and at most once per token window: a second need within
     * the window means another device with this profile keeps taking the key, so this one stops and
     * says so, without telling the server (the other device keeps working). A write that fails is
     * tried again at the next report, and so is one that throws, after the same wait.
     */
    private suspend fun rekey(r: Run) {
        try {
            rekeyNow(r)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Not an answer but something the write or the records did not expect: the need stays,
            // after the wait of a write that got no answer, and the reports go on.
            if (run !== r) return
            r.rekeyDue = true
            backOff(r, PeopleError.offline())
        }
    }

    private suspend fun rekeyNow(r: Run) {
        val slug = r.slug
        val keys = platform?.keys ?: return
        if (!presenceLive(slug)) {
            stop(slug)
            return
        }
        val w = BleProtocol.windowAtMillis(now())
        if (store.record(slug).ble.rekeyW == w) {
            stop(slug, BleProblem.OtherDevice, PeopleText.BLE_OTHER_DEVICE)
            return
        }
        r.rekeyDue = false
        val res = when (val a = host.writePresenceBle(slug, true)) {
            null -> {
                stop(slug)
                return
            }
            is ApiResult.Failed -> {
                if (run !== r) return
                // Presence or the profile is gone on the server; anything else is tried again, after
                // the same wait as a failed report, so an offline phone with nothing heard does not
                // send presence writes back to back.
                if (a.error.status == 403) {
                    stop(slug)
                } else {
                    r.rekeyDue = true
                    backOff(r, a.error)
                }
                return
            }
            is ApiResult.Ok -> a.value
        }
        if (run !== r) return
        // The write went through: the next failure starts its wait from the interval again.
        r.backoffMs = 0
        r.backoffUntil = 0
        val keyId = res.bleKeyId
        val key = BleProtocol.decodeKey(res.bleKey)
        if (key == null || keyId == null || !BleProtocol.isKeyId(keyId)) {
            stop(slug, BleProblem.Failed, PeopleText.BLE_START_FAILED)
            return
        }
        val stored = keys.store(r.alias, key, keyId)
        // Stopped while the key went into the store: the stop removed the key before this one
        // landed, so it goes again (unless a new run at this conference holds the alias by now).
        if (run !== r) {
            if (run?.alias != r.alias) keys.removeQuietly(r.alias)
            return
        }
        if (!stored) {
            stop(slug, BleProblem.Failed, PeopleText.BLE_START_FAILED)
            return
        }
        r.source.keyVersion++
        // Counted only once the new key is in: a write that failed is no sign of another device.
        store.update(slug) { it.copy(ble = it.ble.copy(keyId = keyId, rekeyW = w)) }
        platform.radio.refresh()
    }

    // ---------------------------------------------------------------------------------------------
    // Nearby notifications

    /**
     * The first strong match of the answer (in its rank order) who is not blocked, was not nudged
     * about today and has evidence or a speak topic becomes one notification, at most three in a
     * rolling hour. It names no one; tapping it opens the People tab on "Around now" at their card.
     */
    private suspend fun notifyNearby(slug: String, nearby: List<NearbyPerson>) {
        if (nearby.isEmpty()) return
        val now = now()
        val recent = store.record(slug).ble.notifiedAt.filter { now - it < HOUR_MS }
        if (recent.size >= NOTIFY_PER_HOUR) return
        for (p in nearby) {
            if (host.isBlocked(slug, p.ref) || host.nudgedToday(slug, p.ref)) continue
            val evidence = PeopleText.nearbyEvidence(p) ?: continue
            host.recordNudge(slug, p.ref)
            store.update(slug) { it.copy(ble = it.ble.copy(notifiedAt = recent + now)) }
            host.reveal(slug, p.ref)
            host.notifier.show(NOTIFICATION_ID_PREFIX + slug, ConnectRuntime.NOTIFICATION_TITLE, PeopleText.nearbyText(evidence), ConnectRuntime.NUDGE_DEEP_LINK)
            host.changed()
            return
        }
    }

    companion object {
        /** Reports wait at most this long after failures, however many there were. */
        const val BACKOFF_MAX_MS = 300_000L

        /** A 429's Retry-After is followed up to this long, so a wrong header cannot stop the reports for days. */
        const val RETRY_AFTER_MAX_MS = 3_600_000L

        /** At most this many nearby notifications in a rolling hour. */
        const val NOTIFY_PER_HOUR = 3

        /** A nearby notification's id: one per conference, so a newer one replaces an older one. */
        const val NOTIFICATION_ID_PREFIX = "caddie-ble-"

        private const val HOUR_MS = 3_600_000L

        // The sightings request's RSSI range (people-api.md).
        private const val RSSI_MIN = -127
        private const val RSSI_MAX = 20
    }
}

// The key store is the platform's (the Android Keystore, the iOS Keychain), and either can fail.
// A failure is treated as "no key": the attempt fails or the radio serves nothing, and nothing throws
// into the controller or a radio callback.

/** HMAC under [alias], or null when there is no key or the store failed. */
internal fun BleKeyStore.hmacOrNull(alias: String, message: ByteArray): ByteArray? = try {
    hmac(alias, message)
} catch (e: Exception) {
    null
}

/**
 * Stores [key] as [alias] and checks it is the key [keyId] names; [key] is zeroed either way, since
 * the store keeps its own copy. False when the store failed or the key is not the one named.
 */
internal suspend fun BleKeyStore.store(alias: String, key: ByteArray, keyId: String): Boolean {
    try {
        put(alias, key)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        return false
    } finally {
        key.fill(0)
    }
    val mac = hmacOrNull(alias, BleProtocol.keyIdMessage()) ?: return false
    return BleProtocol.keyIdOf(mac) == keyId
}

/** Removes [alias]; a store that fails is left as it is (the key dies with presence on the server anyway). */
internal suspend fun BleKeyStore.removeQuietly(alias: String) {
    try {
        remove(alias)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        // Nothing more can be done from here.
    }
}
