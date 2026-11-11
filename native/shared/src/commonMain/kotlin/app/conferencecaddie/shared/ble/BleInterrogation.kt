package app.conferencecaddie.shared.ble

/**
 * Decides which phones a radio connects to, to read the token characteristic, when their
 * advertisement does not carry the payload (docs/contracts/ble-tokens.md, Over the air: "scan, then
 * interrogate"). An Android phone puts the payload in its extended advertisement's service data and
 * needs no connection; an iPhone cannot, so it is found by its advertisement and then read over GATT:
 *
 * - [Kind.Service]: the service UUID without service data. An iPhone with the app in the foreground,
 *   or an Android phone's legacy connectable set, seen by a scanner that did not also receive its
 *   extended set. Certainly a Caddie phone, so it is read first.
 * - [Kind.AppleOverflow]: Apple manufacturer data (company 0x004C) whose first byte is 0x01, the
 *   "overflow area" into which iOS moves the service UUIDs of an app advertising in the background.
 *   Only other iPhones can decode the area, but its presence means some app on that iPhone is
 *   advertising a service in the background, so it is the next best guess.
 * - [Kind.Apple]: any other Apple manufacturer data (an iPhone's routine advertisements, but also
 *   AirPods, watches and Macs). An iPhone advertises everything from one address at a time, so an
 *   iPhone running the app in the background can still be reached through these when its overflow
 *   advertisement was missed; most of them are not Caddie phones, which is why they come last.
 *
 * Within a kind, the stronger signal goes first. Only connectable advertisements at or above
 * `near_rssi` are candidates: a sighting weaker than that is not reported anyway, and a connection
 * to a device that only sends non-connectable advertisements would just time out.
 *
 * Every address is read at most once per token window, whatever the outcome ("negative and positive
 * cache"): a token read once is the token for the rest of its window, and a device without the
 * service will not grow one. A connection that failed (no answer, a timeout, a dropped link) is
 * retried after [RETRY_AFTER_FAILURE_MS], and an address that failed [MAX_FAILURES_PER_WINDOW] times
 * is left alone for the rest of the window. The cache starts over at every window change, when every
 * peer's token changes (and an Android peer's address with it).
 *
 * One connection at a time, and at most [maxPerMinute] connections started in any 60 seconds
 * ([MAX_CONNECTIONS_PER_MINUTE] by default; see there for why).
 *
 * Pure logic with the time passed in to every call, so it is deterministic in tests. Not thread-safe:
 * a radio uses it from one thread.
 */
class BleInterrogation(
    /** `ble.near_rssi`: weaker candidates are ignored. */
    private val nearRssi: Int,
    /** Connections started in any 60 seconds, at most. */
    private val maxPerMinute: Int = MAX_CONNECTIONS_PER_MINUTE,
) {
    init {
        require(maxPerMinute > 0) { "maxPerMinute must be positive" }
    }

    /** Why an advertisement is worth a connection, best first. */
    enum class Kind {
        /** The service UUID without service data. */
        Service,

        /** Apple manufacturer data starting with 0x01, the iOS overflow area. */
        AppleOverflow,

        /** Any other Apple manufacturer data. */
        Apple,
    }

    /** What a connection to a candidate found. */
    enum class Outcome {
        /** The token characteristic was read (whatever its value). */
        Read,

        /** Connected, but the device has no such service or characteristic. */
        NotCaddie,

        /** No connection, a timeout, or the link dropped before the read finished. */
        Failed,
    }

    /** A device to connect to now. */
    class Candidate(val address: String, val kind: Kind, val rssi: Int)

    private class Pending(var kind: Kind, var rssi: Int, var seenAt: Long)

    private class Failures(val count: Int, val retryAt: Long)

    private var window = Long.MIN_VALUE
    private val pending = HashMap<String, Pending>()
    private val done = HashSet<String>()
    private val failures = HashMap<String, Failures>()
    private val starts = ArrayDeque<Long>()
    private var inFlight: String? = null
    private var inFlightSince = 0L

    /** True while a connection handed out by [next] has not been [finished]. */
    val busy: Boolean get() = inFlight != null

    /**
     * Notes an advertisement from [address] of [kind] heard at [rssi] dBm. Returns true when the
     * address is now waiting for a connection, false when it is ignored (too weak, already read or
     * given up on in this window, or in flight).
     */
    fun offer(address: String, rssi: Int, kind: Kind, nowMillis: Long): Boolean {
        roll(nowMillis)
        if (rssi < nearRssi || address in done || address == inFlight) return false
        val known = pending[address]
        if (known == null) {
            if (pending.size >= MAX_PENDING) {
                prune(nowMillis)
                if (pending.size >= MAX_PENDING) return false
            }
            pending[address] = Pending(kind, rssi, nowMillis)
            return true
        }
        // The best kind seen from the address, and its strongest signal while it keeps being heard.
        if (kind.ordinal < known.kind.ordinal) known.kind = kind
        known.rssi = if (nowMillis - known.seenAt > OFFER_TTL_MS) rssi else maxOf(known.rssi, rssi)
        known.seenAt = nowMillis
        return true
    }

    /**
     * The candidate to connect to now, or null: none waiting, a connection already in flight, or the
     * cap reached. The candidate is in flight until [finished] is called for it.
     */
    fun next(nowMillis: Long): Candidate? {
        roll(nowMillis)
        val current = inFlight
        if (current != null) {
            // A connection that was never reported back must not stop interrogation for good.
            if (nowMillis - inFlightSince < IN_FLIGHT_LIMIT_MS) return null
            finished(current, Outcome.Failed, nowMillis)
        }
        trimStarts(nowMillis)
        if (starts.size >= maxPerMinute) return null
        prune(nowMillis)
        val best = pending.entries
            .filter { (address, _) -> (failures[address]?.retryAt ?: Long.MIN_VALUE) <= nowMillis }
            .minWithOrNull(compareBy<Map.Entry<String, Pending>>({ it.value.kind.ordinal }, { -it.value.rssi }, { it.key }))
            ?: return null
        pending.remove(best.key)
        inFlight = best.key
        inFlightSince = nowMillis
        starts.addLast(nowMillis)
        return Candidate(best.key, best.value.kind, best.value.rssi)
    }

    /** Records what the connection to [address] found; it is then no longer in flight. */
    fun finished(address: String, outcome: Outcome, nowMillis: Long) {
        if (inFlight == address) inFlight = null
        roll(nowMillis)
        when (outcome) {
            Outcome.Read, Outcome.NotCaddie -> {
                done += address
                failures.remove(address)
            }
            Outcome.Failed -> {
                val count = (failures[address]?.count ?: 0) + 1
                if (count >= MAX_FAILURES_PER_WINDOW) {
                    done += address
                    failures.remove(address)
                } else {
                    failures[address] = Failures(count, nowMillis + RETRY_AFTER_FAILURE_MS)
                }
            }
        }
        if (address in done) pending.remove(address)
    }

    /**
     * The earliest time at which [next] could hand out a candidate that waits now only for the cap
     * or for its retry time, or null when nothing waits that way (or a connection is in flight, whose
     * end is the next chance anyway). A radio sets a timer for it, because nothing else might wake
     * it when the scanner is quiet.
     */
    fun nextAttemptAt(nowMillis: Long): Long? {
        roll(nowMillis)
        if (inFlight != null) return null
        trimStarts(nowMillis)
        val capFreeAt = if (starts.size >= maxPerMinute) starts.first() + MINUTE_MS else nowMillis
        return pending.entries
            .map { (address, p) -> maxOf(capFreeAt, failures[address]?.retryAt ?: nowMillis) to p }
            .filter { (at, p) -> at <= p.seenAt + OFFER_TTL_MS }
            .minOfOrNull { it.first }
    }

    /** Forgets everything: the radio stopped or switched to another configuration. */
    fun reset() {
        window = Long.MIN_VALUE
        pending.clear()
        done.clear()
        failures.clear()
        starts.clear()
        inFlight = null
    }

    /** A new token window: every peer's token has changed, so every address may be read again. */
    private fun roll(nowMillis: Long) {
        val w = BleProtocol.windowAtMillis(nowMillis)
        if (w == window) return
        window = w
        done.clear()
        failures.clear()
    }

    private fun prune(nowMillis: Long) {
        pending.entries.removeAll { nowMillis - it.value.seenAt > OFFER_TTL_MS }
    }

    private fun trimStarts(nowMillis: Long) {
        while (starts.isNotEmpty() && nowMillis - starts.first() >= MINUTE_MS) starts.removeFirst()
    }

    companion object {
        /**
         * Six connections a minute by default. A read takes about half a second to two seconds of
         * radio time (connect, discover the services, read 17 bytes) and at most the radio's timeout
         * of about five seconds, so six keep the phone's radio busy for at most half of each minute
         * and usually for a few seconds, next to advertising, scanning and its own GATT server. A
         * peer needs one read per ten-minute window, so six a minute still reach sixty different
         * phones within a few metres per window, more than stand that close even in a crowded hall,
         * and the strongest kinds and signals are read first. The connection slots of a phone's
         * controller (often about seven) are shared with watches and earbuds; one at a time leaves
         * them free.
         */
        const val MAX_CONNECTIONS_PER_MINUTE = 6

        /** Apple's Bluetooth SIG company identifier, the key of its manufacturer data. */
        const val APPLE_COMPANY_ID = 0x004C

        /** The first byte of Apple manufacturer data that carries the iOS overflow area. */
        const val APPLE_OVERFLOW_TYPE: Byte = 0x01

        /** A candidate not heard again for this long has probably walked away and is dropped. */
        const val OFFER_TTL_MS = 15_000L

        /** A failed connection is tried again after this, at the earliest. */
        const val RETRY_AFTER_FAILURE_MS = 60_000L

        /** After this many failed connections in a window, an address is left alone until the next. */
        const val MAX_FAILURES_PER_WINDOW = 2

        /** A connection not reported back within this is counted as failed. */
        const val IN_FLIGHT_LIMIT_MS = 15_000L

        /** At most this many addresses wait at once; more are ignored until some expire. */
        const val MAX_PENDING = 256

        private const val MINUTE_MS = 60_000L

        /**
         * The kind of an advertisement, or null when it is no candidate: not connectable, or carrying
         * service data for the service UUID (its payload is in the advertisement already, and a value
         * that does not decode would read the same over GATT).
         *
         * @param advertisesService the service UUID is in the advertisement's list of UUIDs.
         * @param serviceData the advertisement's service data for the service UUID, if any.
         * @param appleData the advertisement's manufacturer data for [APPLE_COMPANY_ID], without the
         *   company identifier, if any.
         * @param connectable the advertisement accepts connections.
         */
        fun kindOf(advertisesService: Boolean, serviceData: ByteArray?, appleData: ByteArray?, connectable: Boolean): Kind? = when {
            !connectable || serviceData != null -> null
            advertisesService -> Kind.Service
            appleData == null -> null
            appleData.isNotEmpty() && appleData[0] == APPLE_OVERFLOW_TYPE -> Kind.AppleOverflow
            else -> Kind.Apple
        }
    }
}
