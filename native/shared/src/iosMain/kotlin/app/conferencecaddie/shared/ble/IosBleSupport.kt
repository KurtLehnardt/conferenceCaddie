package app.conferencecaddie.shared.ble

import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import kotlinx.coroutines.withTimeoutOrNull
import platform.CoreBluetooth.CBATTErrorInvalidOffset
import platform.CoreBluetooth.CBATTErrorSuccess
import platform.CoreBluetooth.CBATTErrorUnlikelyError
import platform.CoreBluetooth.CBAdvertisementDataIsConnectable
import platform.CoreBluetooth.CBAdvertisementDataServiceDataKey
import platform.CoreBluetooth.CBManagerAuthorizationAllowedAlways
import platform.CoreBluetooth.CBManagerAuthorizationDenied
import platform.CoreBluetooth.CBManagerAuthorizationNotDetermined
import platform.CoreBluetooth.CBManagerAuthorizationRestricted
import platform.CoreBluetooth.CBManagerStatePoweredOff
import platform.CoreBluetooth.CBManagerStatePoweredOn
import platform.CoreBluetooth.CBManagerStateUnauthorized
import platform.CoreBluetooth.CBManagerStateUnsupported
import platform.CoreBluetooth.CBUUID
import platform.Foundation.NSBundle
import platform.Foundation.NSData
import platform.Foundation.NSDate
import platform.Foundation.NSNumber
import platform.Foundation.NSProcessInfo
import platform.Foundation.create
import platform.Foundation.timeIntervalSince1970
import platform.posix.memcpy

// The pure parts of the iOS radio, apart from Core Bluetooth's objects so that the tests can check
// them on the simulator, where Core Bluetooth itself does nothing.

/** The bytes of [this]. */
@OptIn(ExperimentalForeignApi::class)
internal fun NSData.toByteArray(): ByteArray {
    val size = length.toInt()
    val out = ByteArray(size)
    if (size > 0) out.usePinned { memcpy(it.addressOf(0), bytes, length) }
    return out
}

/** [this] as NSData (a copy). */
@OptIn(ExperimentalForeignApi::class, BetaInteropApi::class)
internal fun ByteArray.toNSData(): NSData =
    if (isEmpty()) NSData() else usePinned { NSData.create(bytes = it.addressOf(0), length = size.toULong()) }

/** The phone's clock in epoch milliseconds. */
internal fun epochMillis(): Long = (NSDate().timeIntervalSince1970 * 1000.0).toLong()

/**
 * True in the iOS simulator, whose Core Bluetooth has no radio. The simulator sets
 * `SIMULATOR_DEVICE_NAME` and `SIMULATOR_UDID` in every process it runs, the app's and the test
 * runner's alike; a device never does.
 */
internal fun runningInSimulator(): Boolean {
    val env = NSProcessInfo.processInfo.environment
    return env["SIMULATOR_DEVICE_NAME"] != null || env["SIMULATOR_UDID"] != null
}

/**
 * True when the app's Info.plist lists [mode] in `UIBackgroundModes`. Core Bluetooth raises an
 * exception (and the app ends) when a manager asks for state restoration without its mode, so the
 * radio asks only when the mode is there; a test process has no such Info.plist.
 */
internal fun declaresBackgroundMode(mode: String): Boolean =
    (NSBundle.mainBundle.objectForInfoDictionaryKey("UIBackgroundModes") as? List<*>)?.any { it == mode } == true

/** [BleAccess] of a `CBManagerAuthorization`. */
internal fun accessOf(authorization: Long): BleAccess = when (authorization) {
    CBManagerAuthorizationNotDetermined -> BleAccess.NotAsked
    CBManagerAuthorizationAllowedAlways -> BleAccess.Granted
    // Denied can be changed only in Settings; restricted (parental controls, device management) not
    // even there. iOS never shows the prompt twice, so there is no Denied-but-askable state.
    CBManagerAuthorizationDenied, CBManagerAuthorizationRestricted -> BleAccess.Blocked
    else -> BleAccess.Blocked
}

/** [BleRadioState] of a `CBManagerState`; unknown and resetting are both "not known yet". */
internal fun radioStateOf(state: Long): BleRadioState = when (state) {
    CBManagerStatePoweredOn -> BleRadioState.Ready
    CBManagerStatePoweredOff -> BleRadioState.PoweredOff
    CBManagerStateUnauthorized -> BleRadioState.Unauthorized
    CBManagerStateUnsupported -> BleRadioState.Unsupported
    else -> BleRadioState.Unknown
}

/** Why a running radio stops when a manager reports [state], or null when it keeps running (or waits). */
internal fun stopReasonOf(state: Long): BleStopReason? = when (state) {
    CBManagerStatePoweredOff -> BleStopReason.BluetoothOff
    CBManagerStateUnauthorized -> BleStopReason.PermissionLost
    CBManagerStateUnsupported -> BleStopReason.Unsupported
    else -> null
}

/** The answer to one ATT read of the token characteristic: the result code and, on success, the value. */
internal class ReadAnswer(val result: Long, val value: ByteArray?)

/**
 * Answers a read at [offset] of [payload]: the bytes from [offset] on (empty at the very end, as
 * ATT expects for a long read that has everything), `CBATTErrorInvalidOffset` past the end, and
 * `CBATTErrorUnlikelyError` when there is no payload (no key, or the radio is not running), so the
 * reader gives up on this phone for the window instead of reporting something that is not a token.
 */
internal fun answerRead(payload: ByteArray?, offset: Long): ReadAnswer = when {
    payload == null -> ReadAnswer(CBATTErrorUnlikelyError, null)
    offset < 0 || offset > payload.size -> ReadAnswer(CBATTErrorInvalidOffset, null)
    else -> ReadAnswer(CBATTErrorSuccess, payload.copyOfRange(offset.toInt(), payload.size))
}

/**
 * The service data an advertisement carries for [serviceUuid] (an Android phone's extended
 * advertisement), or null. Core Bluetooth gives service data as a dictionary from CBUUID to NSData.
 */
internal fun serviceDataOf(advertisementData: Map<Any?, *>, serviceUuid: String): ByteArray? {
    val all = advertisementData[CBAdvertisementDataServiceDataKey] as? Map<*, *> ?: return null
    for ((key, value) in all) {
        val uuid = (key as? CBUUID)?.UUIDString ?: continue
        if (uuid.equals(serviceUuid, ignoreCase = true)) return (value as? NSData)?.toByteArray()
    }
    return null
}

/** False only when the advertisement says it cannot be connected to; absent counts as connectable. */
internal fun connectableOf(advertisementData: Map<Any?, *>): Boolean = when (val v = advertisementData[CBAdvertisementDataIsConnectable]) {
    is Boolean -> v
    is NSNumber -> v.boolValue
    is Number -> v.toInt() != 0
    else -> true
}

/**
 * Which phones without service data the radio connects to, to read their token, and when
 * (docs/contracts/ble-tokens.md, Over the air; docs/NATIVE_PLAN.md 8.2, crowd density). Used on the
 * radio's queue only.
 *
 * - One read at a time ([current]); others wait in a short queue, at most [maxPending], each for at
 *   most [pendingMaxAgeMs] (after that its RSSI says little about where the phone is now).
 * - Every phone (by its Core Bluetooth identifier) is read at most once per token window, whether
 *   the read gave a token or not: its token does not change within the window, and a phone without
 *   the service is not asked again until the next one.
 * - At most [maxPerMinute] connections start in any 60 seconds, so a crowd of iPhones costs a
 *   bounded amount of radio time and battery.
 * - A phone this radio connects to can read this phone's Bluetooth name over that connection, so
 *   it must not also be served this phone's token, which would tie the name to the token: every
 *   phone connected to in the current window is remembered, through a refresh too, and
 *   [mayServe] says no to it as a central.
 *
 * [P] is the peripheral (a CBPeripheral in the app), kept here so the radio holds a strong
 * reference to every phone it is about to connect to.
 */
internal class GattReads<P>(
    private val maxPerMinute: Int = MAX_CONNECTIONS_PER_MINUTE,
    private val maxPending: Int = MAX_PENDING,
    private val pendingMaxAgeMs: Long = PENDING_MAX_AGE_MS,
) {
    /** A phone to read: its identifier, the peripheral, and the RSSI and time it was heard at. */
    class Candidate<P>(val id: String, val peripheral: P, val rssi: Int, val atMillis: Long)

    /** What to do next. */
    sealed interface Next<out P> {
        /** Connect to this one now. */
        class Start<P>(val candidate: Candidate<P>) : Next<P>

        /** The cap is reached: try again at this time. */
        class WaitUntil(val epochMillis: Long) : Next<Nothing>

        /** Nothing to start: a read is running, or nobody is waiting. */
        data object Idle : Next<Nothing>
    }

    private var window = -1L
    private val read = HashSet<String>()

    // The phones connected to (or tried) in this window. Unlike [read], a refresh keeps them: a new
    // key does not make a phone that could read this phone's name over its connection a stranger.
    private val connectedTo = HashSet<String>()
    private val pending = ArrayDeque<Candidate<P>>()
    private val started = ArrayDeque<Long>()

    /** The read running now, or null. */
    var current: Candidate<P>? = null
        private set

    /** The peripherals waiting, for tests. */
    val pendingIds: List<String> get() = pending.map { it.id }

    /** Forgets which phones were read when [nowMillis] lies in another window than the last one seen. */
    fun roll(nowMillis: Long) {
        val w = BleProtocol.windowAtMillis(nowMillis)
        if (w != window) {
            window = w
            read.clear()
            connectedTo.clear()
        }
    }

    /** Forgets which phones were read in this window ([BleRadio.refresh]). */
    fun resetWindow() = read.clear()

    /** True when [id] was read (or tried) in the current window. */
    fun wasRead(id: String): Boolean = id in read

    /**
     * False when the central [id] asking to read this phone's token at [nowMillis] is a phone this
     * radio is reading now or connected to earlier in that window. Core Bluetooth names a remote
     * device by the same identifier whether it shows up as a peripheral or as a central (both are a
     * `CBPeer`), so the peripheral's identifier stands for the central here. Such a phone can read
     * this phone's Bluetooth name over the connection this phone opened; serving it the token too
     * would tie the name to the token.
     */
    fun mayServe(id: String, nowMillis: Long): Boolean {
        roll(nowMillis)
        return current?.id != id && id !in connectedTo
    }

    /**
     * Offers a phone heard without service data. False when it was read in this window, is being
     * read, or was already waiting (then its RSSI and time are updated).
     */
    fun offer(candidate: Candidate<P>): Boolean {
        roll(candidate.atMillis)
        if (candidate.id in read || current?.id == candidate.id) return false
        val waiting = pending.indexOfFirst { it.id == candidate.id }
        if (waiting >= 0) {
            pending[waiting] = candidate
            return false
        }
        if (pending.size >= maxPending) pending.removeFirst()
        pending.addLast(candidate)
        return true
    }

    /** What to do at [nowMillis]. A [Next.Start] makes its candidate [current] and counts it as read. */
    fun next(nowMillis: Long): Next<P> {
        if (current != null) return Next.Idle
        roll(nowMillis)
        while (started.isNotEmpty() && nowMillis - started.first() >= MINUTE_MS) started.removeFirst()
        while (pending.isNotEmpty() && (pending.first().id in read || nowMillis - pending.first().atMillis > pendingMaxAgeMs)) {
            pending.removeFirst()
        }
        if (pending.isEmpty()) return Next.Idle
        if (started.size >= maxPerMinute) return Next.WaitUntil(started.first() + MINUTE_MS)
        val candidate = pending.removeFirst()
        current = candidate
        started.addLast(nowMillis)
        read += candidate.id
        connectedTo += candidate.id
        return Next.Start(candidate)
    }

    /** Ends the current read and returns it. */
    fun finish(): Candidate<P>? = current.also { current = null }

    /**
     * Drops the waiting phones and the current read (the radio stopped). The window's reads, the
     * phones connected to and the connections of the last minute are kept, so stopping and starting
     * again lifts neither the cap nor a refusal.
     */
    fun clear(): Candidate<P>? {
        pending.clear()
        return finish()
    }

    /** Everything held, current first, so the radio can cancel each connection. */
    fun peripherals(): List<P> = listOfNotNull(current?.peripheral) + pending.map { it.peripheral }

    companion object {
        /** Connections started in any 60 seconds, at most. One read takes up to [READ_TIMEOUT_MS]. */
        const val MAX_CONNECTIONS_PER_MINUTE = 10

        /** Phones waiting for a read, at most; the oldest is dropped for a new one. */
        const val MAX_PENDING = 8

        /** A phone that waited longer is dropped; it is heard again at the next scan. */
        const val PENDING_MAX_AGE_MS = 30_000L

        /** Connect, discover the service and the characteristic, and read, within this time or give up. */
        const val READ_TIMEOUT_MS = 5_000L

        private const val MINUTE_MS = 60_000L
    }
}

/**
 * Discoveries that arrive after a relaunch for Bluetooth, before the common runtime has started the
 * radio (the very discovery iOS relaunched the app for, typically): kept, at most [cap] of them, so
 * the radio can take them up once it runs instead of losing them. One per phone (by its Core
 * Bluetooth identifier), the latest; when full, the oldest phone makes room. Used on the radio's
 * queue only.
 */
internal class HeldDiscoveries<T>(private val cap: Int = MAX_HELD_DISCOVERIES) {
    private val held = LinkedHashMap<String, T>()

    /** The number held. */
    val size: Int get() = held.size

    /** Holds [item], heard from the phone [id], in place of anything held for it before. */
    fun add(id: String, item: T) {
        held.remove(id)
        if (held.size >= cap) held.remove(held.keys.first())
        held[id] = item
    }

    /** Everything held, oldest first, and holds nothing afterwards. */
    fun drain(): List<T> {
        val all = held.values.toList()
        held.clear()
        return all
    }

    /** Drops everything held (the radio stopped, or the restoration's grace ended). */
    fun clear() = held.clear()
}

/** Discoveries held after a relaunch, at most. */
internal const val MAX_HELD_DISCOVERIES = 16

/**
 * How long after [now] the radio's next tick is due (all in epoch milliseconds): at most
 * [scanRestartMillis] (the scan restarts that often), at the session's end [untilEpochMillis], and
 * just after the next token window starts ([windowMarginMillis] late, so the tick sees the new
 * window), never sooner than [minMillis].
 */
internal fun tickDelayMillis(
    now: Long,
    untilEpochMillis: Long,
    scanRestartMillis: Long,
    windowMarginMillis: Long,
    minMillis: Long,
): Long {
    val nextWindow = BleProtocol.windowStartMillis(BleProtocol.windowAtMillis(now) + 1)
    return minOf(scanRestartMillis, untilEpochMillis - now, nextWindow - now + windowMarginMillis).coerceAtLeast(minMillis)
}

/**
 * What each central (by its Core Bluetooth identifier) was served, so that no central can read this
 * phone's tokens of two windows, or of two keys, and link them (docs/contracts/ble-tokens.md: the
 * tokens of one phone must not be linkable across windows). Used on the radio's queue only.
 *
 * A central is served one payload only: the one of its first read, in that window. A read in the
 * next window, or after a re-key within the same window, would hand it a second token, so it is
 * refused (`CBATTErrorReadNotPermitted`); a connection held open across a window change therefore
 * gets nothing more. The payload stands for the window and the key version together (it changes
 * exactly when one of them does), and comparing it rather than a version the radio would have to
 * read apart from the payload leaves no moment in which the two disagree.
 *
 * Only the current window and the one before are remembered: once a central's first read is two
 * windows old it is forgotten and served again, like a stranger. Remembering it for the whole
 * session would turn the refusal itself into an oracle that tells a central "you have read this
 * phone before" for as long as the session runs, and would keep a record of every phone met. A
 * phone that connects again under a new random address has a new identifier anyway. At most [cap]
 * centrals are remembered, the one seen least recently making room; [clear] forgets them all when
 * the radio stops.
 */
internal class CentralReadWindows(private val cap: Int = MAX_CENTRALS_REMEMBERED) {
    private class Served(val window: Long, val payload: ByteArray)

    // In the order they were last seen, oldest first.
    private val served = LinkedHashMap<String, Served>()

    // The latest window a read came in, so that older entries are dropped once per window change.
    private var latest = Long.MIN_VALUE

    /** The number of centrals remembered. */
    val size: Int get() = served.size

    /**
     * True when the central [id] may be served [payload], this phone's payload of window [w]: it is
     * not remembered (never served, or first served two or more windows ago), or it was first
     * served this very payload in [w]. Either way it counts as seen now.
     */
    fun allow(id: String, w: Long, payload: ByteArray): Boolean {
        forgetBefore(w - 1)
        val before = served.remove(id)
        if (before == null || before.window < w - 1) {
            if (served.size >= cap) served.remove(served.keys.first())
            served[id] = Served(w, payload.copyOf())
            return true
        }
        served[id] = before
        return before.window == w && before.payload.contentEquals(payload)
    }

    // Drops the centrals first served before [window], when the windows have moved on.
    private fun forgetBefore(window: Long) {
        if (window + 1 <= latest) return
        latest = window + 1
        served.entries.removeAll { it.value.window < window }
    }

    /** Forgets every central (the radio stopped). */
    fun clear() {
        served.clear()
        latest = Long.MIN_VALUE
    }
}

/** Centrals [CentralReadWindows] remembers per radio session, at most. */
internal const val MAX_CENTRALS_REMEMBERED = 1024

/**
 * The iOS radio's gate after a relaunch for Bluetooth, apart from Core Bluetooth (used on the radio's
 * queue only; [schedule] runs a block on that queue after a delay). From [relaunched] until the
 * runtime starts the radio ([started]) or it stops ([stopped]), a read request that arrives is held
 * for [readHoldMillis] rather than refused, since the runtime starts the radio in a moment; and if
 * neither happens within [graceMillis], whatever iOS restored is halted.
 */
internal class RestoreGate<R>(
    private val schedule: (delayMillis: Long, block: () -> Unit) -> Unit,
    private val readHoldMillis: Long = IosBleRadio.READ_HOLD_MS,
    private val graceMillis: Long = IosBleRadio.RESTORE_GRACE_MS,
) {
    /** True from a relaunch until the radio starts or stops. */
    var restoring = false
        private set

    private val held = mutableListOf<R>()

    // Moves on at every start and stop, so the timers of a relaunch that has ended do nothing.
    private var generation = 0

    /** The reads held now. */
    val heldCount: Int get() = held.size

    /** Relaunched for Bluetooth: reads are held from now on, and [onGraceEnded] runs if nothing starts or stops the radio within the grace. */
    fun relaunched(onGraceEnded: () -> Unit) {
        restoring = true
        val mine = generation
        schedule(graceMillis) { if (mine == generation && restoring) onGraceEnded() }
    }

    /**
     * A read that arrived while the radio is not running: true when it is held, false when it is to
     * be refused now (no relaunch is waiting). The first read held starts a wait of [readHoldMillis],
     * after which [onHoldEnded] gets every read held by then, to refuse, unless the radio started or
     * stopped first. The relaunch keeps waiting for the runtime after that.
     */
    fun hold(read: R, onHoldEnded: (List<R>) -> Unit): Boolean {
        if (!restoring) return false
        held += read
        if (held.size == 1) {
            val mine = generation
            schedule(readHoldMillis) { if (mine == generation) onHoldEnded(drain()) }
        }
        return true
    }

    /** The runtime started the radio: the relaunch is over, and the reads held are returned, to answer with the payload. */
    fun started(): List<R> = end()

    /** The radio stopped: the relaunch is over, and the reads held are returned, to refuse. */
    fun stopped(): List<R> = end()

    private fun end(): List<R> {
        generation++
        restoring = false
        return drain()
    }

    private fun drain(): List<R> = held.toList().also { held.clear() }
}

/**
 * Waits for the system's answer to the Bluetooth prompt ([wait]) for at most [timeoutMillis], then
 * returns the access [accessNow] reads. A wait that times out is cancelled, which lets go of whatever
 * it held, and a prompt still unanswered counts as refused (Denied), so the screens show a problem
 * instead of "Starting…" for as long as the prompt stays up.
 */
internal suspend fun awaitAccessDecision(timeoutMillis: Long, wait: suspend () -> Unit, accessNow: () -> BleAccess): BleAccess {
    val decided = withTimeoutOrNull(timeoutMillis) { wait() } != null
    val access = accessNow()
    return if (!decided && access == BleAccess.NotAsked) BleAccess.Denied else access
}

/**
 * Says when the app's Bluetooth authorization differs from the one seen last, so the radio reports
 * a change once ([BleRadio.watchAccess]): an answer to the prompt that came after
 * [awaitAccessDecision] stopped waiting, or a change in Settings that a manager's state update
 * shows. Used on the radio's queue only.
 */
internal class AuthorizationWatch(private var seen: Long) {
    /** True when [authorization] is not the one seen last; it is the one seen from now on. */
    fun changed(authorization: Long): Boolean {
        if (authorization == seen) return false
        seen = authorization
        return true
    }
}
