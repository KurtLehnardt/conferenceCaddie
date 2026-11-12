package app.conferencecaddie.shared.ble

import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
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
        }
    }

    /** Forgets which phones were read in this window ([BleRadio.refresh]). */
    fun resetWindow() = read.clear()

    /** True when [id] was read (or tried) in the current window. */
    fun wasRead(id: String): Boolean = id in read

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
        return Next.Start(candidate)
    }

    /** Ends the current read and returns it. */
    fun finish(): Candidate<P>? = current.also { current = null }

    /**
     * Drops the waiting phones and the current read (the radio stopped). The window's reads and the
     * connections of the last minute are kept, so stopping and starting again does not lift the cap.
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
