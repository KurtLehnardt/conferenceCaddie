package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.GeoFix
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.LocationProvider
import app.conferencecaddie.shared.bundle.IsoTime
import kotlin.math.max
import kotlin.math.roundToLong
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.datetime.TimeZone

/** What [PeopleController.sharePosition] ended with. */
enum class PositionOutcome {
    /** The position is sent with presence from now on (or is off, when it was turned off). */
    On,
    Off,

    /** The system refused location; presence stays zone-only. */
    Denied,

    /** Only approximate location is allowed, which the server does not keep; presence stays zone-only. */
    Approximate,

    /** The device has no location, or the backend does not use positions (no GPS bands). */
    Unavailable,
}

/** What the controller provides to [PresenceRuntime]. */
internal interface PresenceHost {
    val clock: Clock
    val location: LocationProvider
    val pace: Pace

    /** The device's time zone, for the clock time of a toast. */
    val timeZone: TimeZone

    fun changed()

    /** A message for a toast ([PeopleUiState.notice]). */
    fun notice(message: String)

    /**
     * True when the backend keeps the `presence_until` it holds on a write with `until: "keep"`
     * (capabilities `people.presence_keep_until`), so a write of presence that is already on need
     * not move the end of presence.
     */
    fun keepUntil(): Boolean

    /** True while the app is in the foreground. */
    fun foreground(): Boolean

    /** True when the backend uses positions with presence (`people.gps_bands`). */
    fun gpsBands(): Boolean

    /**
     * True while Bluetooth proximity runs at [slug]. The phone is then meant to stay in a pocket,
     * so backgrounding does not end hour-mode presence there.
     */
    fun bluetoothRunning(slug: String): Boolean

    /**
     * Presence of [slug] changed on the device: turned on, moved, extended or ended. Bluetooth
     * follows it (a new `until` for the radio, or a stop when presence ended).
     */
    suspend fun presenceChanged(slug: String)
}

/**
 * Presence ("I'm around") on the device (web/src/people/presence.ts): a zone, and optionally the
 * device's position. The device keeps the switch state; the server enforces `presence_until`.
 *
 * In the hour mode presence turns off by itself at its `until` (60 minutes after it was turned on or
 * extended) and after 5 minutes in the background; "Extend" starts a fresh hour. In the day mode it
 * runs until it is turned off, at the latest at the end of the conference day, and the safeguard is
 * the zone confirmation instead: whenever the app comes back to the foreground with a zone last
 * confirmed more than ten minutes ago, the People tab asks "Still in {zone}?" (hour mode too).
 *
 * The position, with the person's say-so and precise location access only, comes from
 * [LocationProvider.fixes] in the foreground: at most one presence write every 30 seconds
 * (stretched by the API's pace), accuracy rounded to whole metres, stopped in the background and
 * when presence turns off. Every presence write runs one at a time, in the order asked for, so a slow
 * position write can never land after the delete that turned presence off.
 *
 * While Bluetooth proximity runs at a conference ([PresenceHost.bluetoothRunning]), backgrounding
 * does not end its hour-mode presence: the phone is meant to be in a pocket. Presence still ends at
 * its `until`, and the five-minute rule applies again from the moment Bluetooth stops.
 */
internal class PresenceRuntime(
    private val store: PeopleStore,
    private val api: PeopleApi,
    private val scope: CoroutineScope,
    private val host: PresenceHost,
) {
    private fun now() = host.clock.now().toEpochMilliseconds()
    private fun nowIso() = Instant.fromEpochMilliseconds(now()).toString()

    private var watchedSlug: String? = null
    private var expiryJob: Job? = null
    private var hiddenJob: Job? = null
    private var hiddenAt: Long? = null
    private var lastZone: String? = null

    // Moves on whenever presence is turned off here, so a turnOn whose write was still under way
    // does not switch it back on afterwards.
    private var epoch = 0
    private val writes = Mutex()

    // The position watch.
    private var watchJob: Job? = null
    private var watchSlug: String? = null
    private var lastSentAt = 0L
    private var pendingFix: GeoFix? = null
    private var lastSentFix: GeoFix? = null
    private var sendJob: Job? = null
    private var sending = false

    // The position the server holds for each conference, as far as this device knows: the last fix
    // a write carried, until a write without one (a zone change, the position switched off) or the
    // end of presence. A Bluetooth write repeats it, because a presence write replaces every field.
    private val serverFixes = HashMap<String, GeoFix>()

    /** Presence of [slug] as it stands now: presence whose `until` has passed is off. */
    fun get(slug: String): Presence = live(store.presence(slug), now())

    /** The zone the user last chose, for the picker's default. */
    fun lastChosenZone(): String? = lastZone

    private suspend fun set(slug: String, transform: (Presence) -> Presence): Presence {
        val next = store.setPresence(slug) { transform(live(it, now())) }
        host.changed()
        return next
    }

    /** Runs every presence write one at a time, in the order asked for. */
    private suspend fun <T> presenceWrite(fn: suspend () -> T): T = writes.withLock { fn() }

    /**
     * The presence write the web sends: `{ event, zone, spot }`, plus the position when there is one,
     * `until` when it is not the hour, and `ble` when Bluetooth is switched (phase 4). With [keep],
     * `until` is `"keep"`, so the server keeps the `presence_until` it holds instead of the mode's.
     */
    private suspend fun putPresence(
        slug: String,
        zone: String,
        spot: String,
        fix: GeoFix?,
        mode: PresenceMode,
        ble: Boolean? = null,
        keep: Boolean = false,
    ): ApiResult<PresencePutResponse> {
        if (store.deleteCovers(slug)) return ApiResult.Failed(PeopleError.deleteUnfinished())
        return api.putPresence(
            PresencePutRequest(
                event = slug,
                zone = zone,
                spot = Opt.Of(spot.trim().take(SPOT_MAX)),
                location = if (fix != null) Opt.Of(PresenceLocation(fix.lat, fix.lon, fix.accuracyM.roundToLong())) else Opt.Absent,
                until = when {
                    keep -> Opt.Of(PresenceUntil.Keep)
                    mode != PresenceMode.Hour -> Opt.Of(PresenceUntil.of(mode))
                    else -> Opt.Absent
                },
                ble = ble,
            ),
        )
    }

    /**
     * A write of presence that is already on: a Bluetooth write, a re-key, a position, or the
     * position switched off. On a backend that offers `people.presence_keep_until`
     * ([PresenceHost.keepUntil]) it says `until: "keep"`, so the end of presence stays where the
     * person put it: otherwise every such write would start the hour again on the server, and a
     * phone that stopped writing (an app killed in hour mode) would leave the person visible for up
     * to an hour after its last write. Without that capability it asks for [mode], as before. Only
     * [turnOn] (turning presence on, "Extend", "Still in {zone}?") asks for the mode either way.
     *
     * Runs inside the presence write queue. When the server answers 400 `presence_not_active`,
     * presence is not live there, and it ends on the device as well ([endedUnderKeep]).
     */
    private suspend fun putOnPresence(
        slug: String,
        zone: String,
        spot: String,
        fix: GeoFix?,
        mode: PresenceMode,
        ble: Boolean? = null,
    ): ApiResult<PresencePutResponse> {
        val started = epoch
        val keep = host.keepUntil()
        val r = putPresence(slug, zone, spot, fix, mode, ble, keep)
        if (keep && r is ApiResult.Failed && r.error.kind == PeopleError.Kind.PresenceNotActive) endedUnderKeep(slug, started)
        return r
    }

    /**
     * The server refused `until: "keep"` with 400 `presence_not_active`: the presence this device
     * holds as on is not live there (it ran out, or a delete, the purge or another device cleared
     * it), and `keep` never starts it. Presence ends on the device as it does at its `until`: no
     * toast and no request, the timers and the position watch stop, Bluetooth stops on the device
     * (the server holds no session for presence that is gone), and the screens follow the new state,
     * the Around list included. Presence turned off here while the write was under way is off
     * already, with its delete queued.
     *
     * This runs inside the presence write queue and leaves the epoch alone, unlike
     * [presenceEndedOnServer]: a turn-on queued behind the refused write was asked for after it, and
     * its answer (presence started again with the hour or the day) must still be recorded.
     */
    private suspend fun endedUnderKeep(slug: String, started: Int) {
        if (epoch != started) return
        endOnDevice(slug)
    }

    // ---------------------------------------------------------------------------------------------
    // Turning presence on and off

    /**
     * Turns presence on (or moves it) and restarts the hour. The write itself is zone-only; with the
     * position choice the watch (re)starts and sends the first fix as soon as there is one. Returns
     * an error message, or null. It asks for [mode] even where the backend offers `until: "keep"`:
     * this is the person choosing the end of presence (turning it on, "Extend", "Still in {zone}?").
     */
    suspend fun turnOn(slug: String, zone: String, spot: String, mode: PresenceMode = get(slug).mode): String? {
        val started = epoch
        val r = presenceWrite { putPresence(slug, zone, spot, null, mode) }
        val res = when (r) {
            is ApiResult.Failed -> return PeopleText.presenceProblem(r.error)
            is ApiResult.Ok -> r.value
        }
        // Turned off while the write was under way: the delete queued behind it has the last word.
        if (epoch != started) return null
        val until = untilOf(res)
        lastZone = zone
        val position = get(slug).positionChoice == PositionChoice.Yes && canSendPosition()
        set(slug) { p ->
            p.copy(
                on = true,
                zone = zone,
                spot = spot.trim().take(SPOT_MAX),
                until = until,
                noticeSeen = true,
                position = position,
                mode = mode,
                confirmedAt = nowIso(),
                confirmPending = false,
                recentZones = withRecent(p.recentZones, zone),
                spotHidden = res.spotHidden,
                held = res.held,
            )
        }
        // The write was zone-only, so the server holds no position until the next fix.
        serverFixes.remove(slug)
        if (watchedSlug == slug) scheduleExpiry(slug)
        lastSentAt = 0
        stopPositionWatch()
        syncPositionWatch(slug)
        host.presenceChanged(slug)
        return null
    }

    // The presence_until a presence write's answer names, or an hour from now when it names none
    // that can be read: the server restarts the hour on every presence write.
    private fun untilOf(res: PresencePutResponse): String =
        res.presenceUntil?.takeIf { IsoTime.epochMillis(it) != null }
            ?: Instant.fromEpochMilliseconds(now() + PRESENCE_MINUTES * 60_000L).toString()

    /** Keeps the zone and spot and starts a fresh hour (or renews the day). */
    suspend fun extend(slug: String): String? {
        val p = get(slug)
        val zone = p.zone
        if (!p.on || zone == null) return null
        return turnOn(slug, zone, p.spot, p.mode)
    }

    /**
     * Turns presence off on the device at once and tells the server once any presence write still
     * under way has finished; a failed delete is retried once.
     */
    suspend fun turnOff(slug: String) {
        val raw = store.presence(slug)
        if (raw.on) lastZone = raw.zone
        epoch++
        store.setPresence(slug) { it.off() }
        serverFixes.remove(slug)
        host.changed()
        if (watchedSlug == slug) clearTimers()
        stopPositionWatch()
        // Bluetooth stops with presence, on the device only: the presence delete ends its session.
        host.presenceChanged(slug)
        presenceWrite {
            if (api.deletePresence(slug) is ApiResult.Failed) {
                // The server lets it lapse on its own at presence_until otherwise.
                api.deletePresence(slug)
            }
        }
    }

    /**
     * Presence the server has already cleared (conference-wide visibility turned off, the profile
     * deleted): off on the device too, with its timers and the position watch, and no request.
     */
    suspend fun presenceEndedOnServer(slug: String) {
        epoch++
        endOnDevice(slug)
    }

    // Presence off on the device, with its timers and the position watch, and Bluetooth told; no request.
    private suspend fun endOnDevice(slug: String) {
        val raw = store.presence(slug)
        if (raw.on) {
            lastZone = raw.zone
            store.setPresence(slug) { it.off() }
            host.changed()
        }
        serverFixes.remove(slug)
        if (watchedSlug == slug) clearTimers()
        if (watchSlug == slug) stopPositionWatch()
        host.presenceChanged(slug)
    }

    /**
     * Stops the timers and the position watch while another backend is selected. Unlike [reset] it
     * leaves a presence write that is under way alone, so its answer is still recorded; [watch]
     * installs everything again when the backend comes back.
     */
    fun pause() {
        unwatch()
    }

    /** Stops every presence timer and the position watch, for "Delete my profile". */
    fun reset() {
        epoch++
        clearTimers()
        stopPositionWatch()
        serverFixes.clear()
        hiddenAt = null
        lastZone = null
    }

    // ---------------------------------------------------------------------------------------------
    // Bluetooth proximity

    /**
     * Writes presence again with `ble` set ([ble] true starts or re-keys Bluetooth, false stops it),
     * repeating the current presence in full: the zone, the spot line, the position the server holds
     * (only while the position is on) and the duration mode. A presence write replaces every
     * presence field from its body, so a write that sent only the zone would clear the spot line and
     * the position (docs/contracts/ble-tokens.md, Re-keying). It runs in the presence write queue and
     * returns null, sending nothing, when presence is off by the time its turn comes.
     *
     * The server restarts presence's hour (or renews the day) on every presence write, `ble` or not,
     * unless the backend offers `people.presence_keep_until` ([PresenceHost.keepUntil]): then the
     * write says `until: "keep"` and the server keeps the `presence_until` it holds, and a 400
     * `presence_not_active` ends presence here too ([putOnPresence]). Either way, as
     * [turnOn] does, the device takes the `presence_until` the answer names, with the spot line's
     * state, and its expiry and the radio's deadline follow it: otherwise the person would stay
     * visible, and their tokens resolvable, for up to an hour after the device says presence ended.
     * When that moves the end of presence to another minute, a toast says until when it now runs.
     */
    suspend fun writeBle(slug: String, ble: Boolean): ApiResult<PresencePutResponse>? {
        val started = epoch
        val r = presenceWrite {
            val p = get(slug)
            val zone = p.zone
            if (!p.on || zone == null) return@presenceWrite null
            putOnPresence(slug, zone, p.spot, if (p.position) serverFixes[slug] else null, p.mode, ble)
        }
        if (r is ApiResult.Ok) followWrite(slug, r.value, started)
        return r
    }

    // A write that repeated presence went through: the device keeps the until and the spot line's
    // state the server now holds. Presence turned off (or ended on the server) while the write was
    // under way stays off: the delete queued behind it has the last word. An end that moved to
    // another clock minute is told, so the person knows presence now runs longer than they chose.
    private suspend fun followWrite(slug: String, res: PresencePutResponse, started: Int) {
        val before = get(slug)
        if (epoch != started || !before.on) return
        val until = untilOf(res)
        set(slug) { p -> if (p.on) p.copy(until = until, spotHidden = res.spotHidden, held = res.held) else p }
        if (watchedSlug == slug) scheduleExpiry(slug)
        host.presenceChanged(slug)
        val beforeMs = before.until?.let { IsoTime.epochMillis(it) } ?: return
        val afterMs = IsoTime.epochMillis(until) ?: return
        if (!get(slug).on) return
        val text = PeopleText.presenceRunsUntil(afterMs, host.timeZone)
        if (text != PeopleText.presenceRunsUntil(beforeMs, host.timeZone)) host.notice(text)
    }

    /**
     * Bluetooth started or stopped at [slug] while the app is in the background. Started: the
     * five-minute turn-off is called off. Stopped: hour-mode presence ends five minutes from now,
     * as if the app had just gone to the background.
     */
    fun onBluetoothChanged(slug: String) {
        if (watchedSlug != slug || host.foreground()) return
        hiddenJob?.cancel()
        hiddenJob = null
        if (host.bluetoothRunning(slug)) return
        hiddenAt = now()
        scheduleHidden(slug)
    }

    // ---------------------------------------------------------------------------------------------
    // Zone confirmation

    // Flags a zone that has not been confirmed within the threshold, so the People tab asks about it.
    private suspend fun checkZoneAge(slug: String) {
        val p = get(slug)
        if (!p.on || p.zone == null || p.confirmPending) return
        val confirmed = p.confirmedAt?.let { IsoTime.epochMillis(it) }
        val age = if (confirmed == null) Long.MAX_VALUE else now() - confirmed
        if (age > ZONE_CONFIRM_MS) set(slug) { it.copy(confirmPending = true) }
    }

    /**
     * The zones to offer beside "Yes", most likely first: the zones this device chose before, most
     * recent first, then the rest of [zones] in order; never the current zone.
     */
    fun likelyZones(slug: String, zones: List<String>, count: Int = 4): List<String> {
        val p = get(slug)
        val out = ArrayList<String>()
        for (z in p.recentZones + zones) {
            if (z != p.zone && z in zones && z !in out) out += z
            if (out.size >= count) break
        }
        return out
    }

    /** "Still in {zone}?" answered: the same zone, or a new one. Both write presence and record the time. */
    suspend fun confirmZone(slug: String, zone: String): String? {
        val p = get(slug)
        if (!p.on) return null
        return turnOn(slug, zone, p.spot, p.mode)
    }

    /** The row closed without an answer: that counts as "yes" until the next threshold. */
    suspend fun dismissZoneCheck(slug: String) {
        set(slug) { it.copy(confirmPending = false, confirmedAt = nowIso()) }
    }

    // ---------------------------------------------------------------------------------------------
    // The selected conference and the app's lifecycle

    /** Installs the expiry and background timers (and the position watch) for the selected conference. */
    suspend fun watch(slug: String?) {
        if (watchedSlug == slug) return
        unwatch()
        watchedSlug = slug ?: return
        scheduleExpiry(slug)
        if (host.foreground()) {
            // Opening the app again counts as coming to the foreground.
            checkZoneAge(slug)
            syncPositionWatch(slug)
        } else {
            onBackground()
        }
    }

    private fun unwatch() {
        clearTimers()
        stopPositionWatch()
        hiddenAt = null
        watchedSlug = null
    }

    fun onBackground() {
        val slug = watchedSlug ?: return
        hiddenJob?.cancel()
        hiddenJob = null
        if (hiddenAt == null) hiddenAt = now()
        scheduleHidden(slug)
        // Positions are foreground only.
        stopPositionWatch()
    }

    // Five minutes in the background end an hour-mode presence. In the day mode backgrounding is the
    // normal state (the phone is in a pocket), so presence stays and the next foreground asks whether
    // the zone still holds. The same holds while Bluetooth runs at this conference.
    private fun scheduleHidden(slug: String) {
        val p = get(slug)
        if (!p.on || p.mode != PresenceMode.Hour || host.bluetoothRunning(slug)) return
        hiddenJob = scope.launch {
            delay(HIDDEN_MS)
            hiddenJob = null
            scope.launch { turnOff(slug) }
        }
    }

    suspend fun onForeground() {
        val slug = watchedSlug ?: return
        hiddenJob?.cancel()
        hiddenJob = null
        val away = hiddenAt?.let { now() - it } ?: 0
        hiddenAt = null
        val raw = store.presence(slug)
        val untilMs = raw.until?.let { IsoTime.epochMillis(it) }
        // Back after a long time away: the server has already let it lapse. Or back in hour mode
        // after five minutes or more: the timer could not run while the app was suspended. Not
        // while Bluetooth runs here, which keeps presence in the pocket until its until.
        val hiddenTooLong = raw.mode == PresenceMode.Hour && away >= HIDDEN_MS && !host.bluetoothRunning(slug)
        if (raw.on && ((untilMs != null && untilMs <= now()) || hiddenTooLong)) {
            turnOff(slug)
        } else {
            checkZoneAge(slug)
            syncPositionWatch(slug)
        }
    }

    private fun scheduleExpiry(slug: String) {
        expiryJob?.cancel()
        expiryJob = null
        val p = get(slug)
        val untilMs = p.until?.let { IsoTime.epochMillis(it) } ?: return
        if (!p.on) return
        val ms = max(0, untilMs - now())
        expiryJob = scope.launch {
            delay(ms)
            expiryJob = null
            scope.launch { turnOff(slug) }
        }
    }

    private fun clearTimers() {
        expiryJob?.cancel()
        hiddenJob?.cancel()
        expiryJob = null
        hiddenJob = null
    }

    // ---------------------------------------------------------------------------------------------
    // Position

    /** True when a position may be sent at all: the backend uses GPS bands and precise location is allowed. */
    private fun canSendPosition(): Boolean = host.gpsBands() && host.location.access() == LocationAccess.Precise

    /**
     * Turns the position on or off for presence. On asks for location access when it was never
     * asked; the watch then starts and sends its first fix at once. Off clears the stored position on
     * the server with the next zone write, sent right away.
     */
    suspend fun sharePosition(slug: String, on: Boolean): PositionOutcome {
        if (on) {
            if (!host.gpsBands()) return PositionOutcome.Unavailable
            var access = host.location.access()
            if (access == LocationAccess.NotAsked) access = host.location.requestAccess()
            val outcome = when (access) {
                LocationAccess.Precise -> PositionOutcome.On
                LocationAccess.Approximate -> PositionOutcome.Approximate
                LocationAccess.Denied -> PositionOutcome.Denied
                LocationAccess.Unavailable, LocationAccess.NotAsked -> PositionOutcome.Unavailable
            }
            val choice = if (outcome == PositionOutcome.Denied || outcome == PositionOutcome.Unavailable) PositionChoice.No else PositionChoice.Yes
            set(slug) { it.copy(position = outcome == PositionOutcome.On && it.on, positionChoice = choice) }
            val p = get(slug)
            if (outcome == PositionOutcome.On && p.on && p.zone != null) {
                lastSentAt = 0
                syncPositionWatch(slug)
            }
            return outcome
        }
        val before = get(slug)
        set(slug) { it.copy(position = false, positionChoice = PositionChoice.No) }
        serverFixes.remove(slug)
        syncPositionWatch(slug)
        if (before.on && before.zone != null) {
            presenceWrite {
                val now = get(slug)
                val zone = now.zone
                // It lapses with the presence otherwise. The device keeps its until, as for a fix (sendFix).
                if (now.on && zone != null) putOnPresence(slug, zone, now.spot, null, now.mode)
            }
        }
        return PositionOutcome.Off
    }

    // Keeps the watch in step with the stored state: running while presence is on with the
    // position choice, the conference is the watched one and the app is in the foreground, stopped
    // otherwise. A write that lands after its backend was left starts no watch.
    private fun syncPositionWatch(slug: String) {
        val p = get(slug)
        val wanted = watchedSlug == slug && p.on && p.position && host.foreground() && canSendPosition()
        if (wanted && watchSlug != slug) startPositionWatch(slug) else if (!wanted && watchSlug != null) stopPositionWatch()
    }

    private fun startPositionWatch(slug: String) {
        stopPositionWatch()
        if (!host.foreground()) return
        watchSlug = slug
        watchJob = scope.launch {
            host.location.fixes().collect { onFix(slug, it) }
        }
    }

    private fun stopPositionWatch() {
        watchJob?.cancel()
        watchJob = null
        watchSlug = null
        pendingFix = null
        lastSentFix = null
        sendJob?.cancel()
        sendJob = null
    }

    private fun onFix(slug: String, fix: GeoFix) {
        if (!host.foreground() || watchSlug != slug) return
        if (!fix.lat.isFinite() || !fix.lon.isFinite()) return
        pendingFix = if (fix.accuracyM.isFinite()) fix else fix.copy(accuracyM = 1e6)
        val wait = lastSentAt + host.pace.pacedMs(POSITION_MIN_INTERVAL_MS) - now()
        if (wait <= 0) {
            scope.launch { sendFix(slug) }
        } else if (sendJob == null) {
            sendJob = scope.launch {
                delay(wait)
                sendJob = null
                scope.launch { sendFix(slug) }
            }
        }
    }

    // Sends the newest fix with the current zone and spot. On a backend that offers
    // people.presence_keep_until the write says until: "keep", so the server keeps the
    // presence_until it holds, which is the device's, and a 400 presence_not_active ends presence
    // here too (putOnPresence). Without it the server starts the hour (or the day) again on this
    // write, but unlike a Bluetooth write (writeBle) this one does not move the device's until: the
    // device keeps its own, and when that runs out its expiry turns presence off with a delete, which
    // ends it on the server too.
    private suspend fun sendFix(slug: String) {
        sendJob?.cancel()
        sendJob = null
        if (sending) {
            // A write is still in flight: the newest fix waits for it.
            sendJob = scope.launch {
                delay(1_000)
                sendJob = null
                scope.launch { sendFix(slug) }
            }
            return
        }
        val fix = pendingFix
        pendingFix = null
        fun wanted(): Presence? = get(slug).takeIf { it.on && it.zone != null && it.position && watchSlug == slug }
        if (fix == null || wanted() == null) return
        sending = true
        lastSentAt = now()
        try {
            presenceWrite {
                // Presence may have been turned off while this waited its turn.
                val p = wanted() ?: return@presenceWrite
                when (val r = putOnPresence(slug, p.zone!!, p.spot, fix, p.mode)) {
                    is ApiResult.Ok -> {
                        lastSentFix = fix
                        serverFixes[slug] = fix
                    }
                    is ApiResult.Failed -> {
                        // A profile that is gone, or presence the server no longer accepts: stop
                        // sending positions (presence_not_active has ended presence here already).
                        // A 409 or a 429 tries again with the next fix.
                        val s = r.error.status
                        if (s in 400..499 && s != 429 && s != 409) stopPositionWatch()
                    }
                }
            }
        } finally {
            sending = false
        }
    }

    companion object {
        const val PRESENCE_MINUTES = 60
        const val HIDDEN_MS = 5 * 60_000L

        /** A zone older than this is asked about when the app comes back to the foreground. */
        const val ZONE_CONFIRM_MS = 10 * 60_000L

        /** A position is sent at most this often at pace 1, stretched by the pace the API reports. */
        const val POSITION_MIN_INTERVAL_MS = 30_000L
        const val RECENT_ZONES_MAX = 8
        const val SPOT_MAX = 60

        private fun withRecent(zones: List<String>, zone: String): List<String> = (listOf(zone) + zones.filter { it != zone }).take(RECENT_ZONES_MAX)

        /** Presence as it stands at [nowMs]: presence whose `until` has passed is off. */
        fun live(raw: Presence, nowMs: Long): Presence {
            val untilMs = raw.until?.let { IsoTime.epochMillis(it) }
            val on = raw.on && untilMs != null && untilMs > nowMs
            if (on) return raw
            if (!raw.on && raw.zone == null && raw.until == null && !raw.position && raw.confirmedAt == null && !raw.confirmPending) return raw
            return raw.off()
        }
    }
}

/** Presence switched off: the zone, time, position and confirmation go; the spot, choices and recent zones stay. */
internal fun Presence.off(): Presence =
    copy(on = false, zone = null, until = null, position = false, confirmedAt = null, confirmPending = false, held = null, spotHidden = false)
