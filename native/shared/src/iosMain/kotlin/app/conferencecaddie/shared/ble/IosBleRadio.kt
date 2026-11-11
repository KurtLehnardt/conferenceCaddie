package app.conferencecaddie.shared.ble

import kotlin.coroutines.resume
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.ObjCSignatureOverride
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import platform.CoreBluetooth.CBATTErrorRequestNotSupported
import platform.CoreBluetooth.CBATTErrorUnlikelyError
import platform.CoreBluetooth.CBATTRequest
import platform.CoreBluetooth.CBAdvertisementDataServiceUUIDsKey
import platform.CoreBluetooth.CBAttributePermissionsReadable
import platform.CoreBluetooth.CBCentralManager
import platform.CoreBluetooth.CBCentralManagerDelegateProtocol
import platform.CoreBluetooth.CBCentralManagerOptionRestoreIdentifierKey
import platform.CoreBluetooth.CBCentralManagerOptionShowPowerAlertKey
import platform.CoreBluetooth.CBCentralManagerRestoredStatePeripheralsKey
import platform.CoreBluetooth.CBCentralManagerScanOptionAllowDuplicatesKey
import platform.CoreBluetooth.CBCharacteristic
import platform.CoreBluetooth.CBCharacteristicPropertyRead
import platform.CoreBluetooth.CBErrorAlreadyAdvertising
import platform.CoreBluetooth.CBErrorDomain
import platform.CoreBluetooth.CBManager
import platform.CoreBluetooth.CBManagerAuthorizationNotDetermined
import platform.CoreBluetooth.CBManagerStatePoweredOn
import platform.CoreBluetooth.CBManagerStateResetting
import platform.CoreBluetooth.CBManagerStateUnknown
import platform.CoreBluetooth.CBMutableCharacteristic
import platform.CoreBluetooth.CBMutableService
import platform.CoreBluetooth.CBPeripheral
import platform.CoreBluetooth.CBPeripheralDelegateProtocol
import platform.CoreBluetooth.CBPeripheralManager
import platform.CoreBluetooth.CBPeripheralManagerDelegateProtocol
import platform.CoreBluetooth.CBPeripheralManagerOptionRestoreIdentifierKey
import platform.CoreBluetooth.CBPeripheralManagerOptionShowPowerAlertKey
import platform.CoreBluetooth.CBPeripheralManagerRestoredStateServicesKey
import platform.CoreBluetooth.CBService
import platform.CoreBluetooth.CBUUID
import platform.Foundation.NSError
import platform.Foundation.NSNumber
import platform.darwin.NSObject
import platform.darwin.dispatch_async
import platform.darwin.dispatch_queue_create
import platform.darwin.dispatch_sync
import platform.darwin.dispatch_walltime

/**
 * [BleRadio] on Core Bluetooth (docs/contracts/ble-tokens.md, Over the air; docs/NATIVE_PLAN.md 5.1).
 *
 * - **Advertising.** A peripheral manager publishes one primary service ([BleRadioConfig.serviceUuid])
 *   with the read-only token characteristic, whose value is left nil so that every read reaches
 *   this radio and is answered with [BlePayloadSource.payloadNow] at that moment. The advertisement
 *   holds the service UUID only: iOS cannot advertise service data, and in the background it moves
 *   the UUID to the overflow area, which only iPhones scanning for it can see. Nothing in the
 *   advertisement depends on the token, so [refresh] has nothing to re-advertise; the address is
 *   iOS's own, rotated on its own schedule.
 * - **Scanning.** A central manager scans for the service UUID. An advertisement with service data
 *   for it (an Android phone's extended advertisement) is handed to the runtime as heard. Any
 *   other phone at or above [BleRadioConfig.nearRssi] is connected to and its characteristic read,
 *   one at a time, at most once per token window and at most [GattReads.MAX_CONNECTIONS_PER_MINUTE]
 *   connections a minute, each given up after [GattReads.READ_TIMEOUT_MS] ([GattReads]). The scan
 *   restarts every [SCAN_RESTART_MS] and at each window change, because Core Bluetooth reports a
 *   phone only once per scan: without it a phone first heard far away would never be heard again
 *   when it comes near.
 * - **Background.** The app declares `bluetooth-central` and `bluetooth-peripheral`, and both
 *   managers ask for state restoration ([CENTRAL_RESTORE_ID], [PERIPHERAL_RESTORE_ID]), so iOS keeps
 *   advertising and scanning while the app is suspended, wakes it for discoveries and read
 *   requests, and relaunches it after it ended the app. On such a launch [IosBle.restoreAfterLaunch]
 *   recreates the managers before `didFinishLaunching` returns, as Core Bluetooth requires, and read
 *   requests that arrive before the common runtime has started the radio are held for
 *   [READ_HOLD_MS] rather than refused. An event delivered in the background holds the app awake a
 *   little longer ([WakeHold]) for the runtime's sightings upload.
 * - **Threads.** Both managers deliver on one serial dispatch queue, where all of the radio's state
 *   lives; the public methods hand their work to it and never wait for it, so they can be called
 *   from any thread, the queue included. Events are called on that queue.
 * - **The simulator** has no Bluetooth radio: there the radio is not [supported], creates no
 *   manager, and a [start] stops at once with [BleStopReason.Unsupported].
 *
 * Nothing here logs: no payload, token, peripheral identifier or RSSI.
 */
@OptIn(ExperimentalForeignApi::class)
class IosBleRadio internal constructor(
    private val simulator: Boolean = runningInSimulator(),
    private val restoration: Boolean = true,
    private val clock: () -> Long = ::epochMillis,
    private val wake: WakeHold = UiBackgroundGrace(),
) : BleRadio {
    private val queue = dispatch_queue_create("app.conferencecaddie.ble", null)
    private val centralDelegate = CentralDelegate(this)
    private val peripheralManagerDelegate = PeripheralManagerDelegate(this)
    private val peripheralDelegate = PeripheralDelegate(this)

    // Created on the queue; read from any thread by state().
    @kotlin.concurrent.Volatile
    private var central: CBCentralManager? = null

    @kotlin.concurrent.Volatile
    private var peripheralManager: CBPeripheralManager? = null

    @kotlin.concurrent.Volatile
    private var started = false

    // Everything below is used on the queue only.
    private var active = false
    private var config: BleRadioConfig? = null
    private var source: BlePayloadSource? = null
    private var events: BleRadioEvents? = null

    /** Changes whenever the radio starts or stops, so the timers of an earlier run do nothing. */
    private var generation = 0
    private var service: CBMutableService? = null
    private var serviceAdded = false
    private var addingService = false
    private var restoredServices: List<CBMutableService> = emptyList()
    private val restoredPeripherals = mutableListOf<CBPeripheral>()

    /** Relaunched by iOS for Bluetooth, and the runtime has not started the radio yet. */
    private var restoring = false
    private val heldReads = mutableListOf<Pair<CBPeripheralManager, CBATTRequest>>()
    private val reads = GattReads<CBPeripheral>()
    private var pumpScheduled = false
    private val decisionWaiters = mutableListOf<CancellableContinuation<Unit>>()
    private var decisionPolling = false

    override val supported: Boolean get() = !simulator

    override val permissionKind: BlePermissionKind get() = BlePermissionKind.Bluetooth

    override val running: Boolean get() = started

    override fun access(): BleAccess = accessOf(CBManager.authorization)

    /**
     * Creates the managers, which shows the system prompt while the person has not decided, and
     * waits until iOS has an answer: the authorization is decided and the central manager knows its
     * state. Cancellable; on the simulator it answers at once.
     */
    override suspend fun requestAccess(): BleAccess {
        if (simulator) return access()
        suspendCancellableCoroutine { waiter ->
            dispatch_async(queue) {
                ensureManagers()
                decisionWaiters += waiter
                checkDecision()
            }
            waiter.invokeOnCancellation { dispatch_async(queue) { decisionWaiters.remove(waiter) } }
        }
        return access()
    }

    override fun state(): BleRadioState {
        if (simulator) return BleRadioState.Unsupported
        central?.let { return radioStateOf(it.state) }
        return when (access()) {
            // Allowed: the managers can be created without a prompt, and report their state in a moment.
            BleAccess.Granted -> {
                dispatch_async(queue) { ensureManagers() }
                BleRadioState.Unknown
            }
            else -> BleRadioState.Unauthorized
        }
    }

    override fun start(config: BleRadioConfig, source: BlePayloadSource, events: BleRadioEvents) {
        if (simulator) {
            dispatch_async(queue) { notifyStopped(events, BleStopReason.Unsupported) }
            return
        }
        started = true
        dispatch_async(queue) { begin(config, source, events) }
    }

    /** Only per-window state changes: the advertisement holds no token, and reads always get [BlePayloadSource.payloadNow]. */
    override fun refresh() {
        if (simulator) return
        dispatch_async(queue) {
            if (!active) return@dispatch_async
            reads.resetWindow()
            startScan()
            pump()
        }
    }

    override fun stop() {
        started = false
        if (simulator) return
        dispatch_async(queue) { halt() }
    }

    /**
     * Recreates both managers now, with their restore identifiers, because iOS relaunched the app
     * for Bluetooth ([IosBle.restoreAfterLaunch], on the main thread inside `didFinishLaunching`).
     * Their `willRestoreState` arrives before anything else. If the common runtime has not started
     * the radio within [RESTORE_GRACE_MS] (its presence ended while the app was gone), whatever iOS
     * restored is stopped.
     */
    internal fun resumeAfterLaunch() {
        if (simulator || access() != BleAccess.Granted) return
        // The queue never waits for the main thread, so waiting for it here cannot deadlock.
        dispatch_sync(queue) {
            if (!active) {
                restoring = true
                val run = generation
                after(RESTORE_GRACE_MS) {
                    if (run == generation && restoring && !active) halt()
                }
            }
            ensureManagers()
        }
    }

    // ---------------------------------------------------------------------------------------------
    // On the queue.

    private fun ensureManagers() {
        if (central == null) {
            val options = mutableMapOf<Any?, Any?>(CBCentralManagerOptionShowPowerAlertKey to false)
            if (restoration && declaresBackgroundMode("bluetooth-central")) options[CBCentralManagerOptionRestoreIdentifierKey] = CENTRAL_RESTORE_ID
            central = CBCentralManager(centralDelegate, queue, options)
        }
        if (peripheralManager == null) {
            val options = mutableMapOf<Any?, Any?>(CBPeripheralManagerOptionShowPowerAlertKey to false)
            if (restoration && declaresBackgroundMode("bluetooth-peripheral")) options[CBPeripheralManagerOptionRestoreIdentifierKey] = PERIPHERAL_RESTORE_ID
            peripheralManager = CBPeripheralManager(peripheralManagerDelegate, queue, options)
        }
    }

    private fun begin(config: BleRadioConfig, source: BlePayloadSource, events: BleRadioEvents) {
        val switching = active
        val previous = this.config
        val moved = switching && previous != null &&
            (previous.serviceUuid != config.serviceUuid || previous.characteristicUuid != config.characteristicUuid)
        if (moved) withdraw()
        this.config = config
        this.source = source
        this.events = events
        active = true
        started = true
        restoring = false
        val run = ++generation
        pumpScheduled = false
        val now = clock()
        if (now >= config.untilEpochMillis) {
            stopSelf(BleStopReason.System)
            return
        }
        ensureManagers()
        answerHeldReads()
        scheduleTick(run)
        if (!switching || moved) {
            reads.roll(now)
            // Either manager may know its state already (a restart, a restoration) or report it in a moment.
            centralStateChanged()
            if (active) peripheralStateChanged()
        }
    }

    /** Stops advertising, the service and the scan, and drops every connection; [active] is unchanged. */
    private fun withdraw() {
        peripheralManager?.takeIf { it.state == CBManagerStatePoweredOn }?.let { pm ->
            if (pm.isAdvertising) pm.stopAdvertising()
            pm.removeAllServices()
        }
        service = null
        serviceAdded = false
        addingService = false
        restoredServices = emptyList()
        val held = reads.peripherals()
        reads.clear()
        central?.takeIf { it.state == CBManagerStatePoweredOn }?.let { c ->
            c.stopScan()
            for (p in held + restoredPeripherals) {
                p.delegate = null
                c.cancelPeripheralConnection(p)
            }
            restoredPeripherals.clear()
        }
    }

    private fun halt() {
        active = false
        started = false
        restoring = false
        generation++
        config = null
        source = null
        events = null
        answerHeldReads()
        withdraw()
        // Powered off: the connections are gone with the radio, but the references must go too.
        restoredPeripherals.clear()
        wake.release()
    }

    private fun stopSelf(reason: BleStopReason) {
        if (!active) return
        val listener = events
        halt()
        if (listener != null) notifyStopped(listener, reason)
    }

    private fun notifyStopped(listener: BleRadioEvents, reason: BleStopReason) {
        try {
            listener.onStopped(reason)
        } catch (e: Exception) {
            // The runtime's handler failing must not end the process from the radio's queue.
        }
    }

    private fun deliver(payload: ByteArray, rssi: Int, atEpochMillis: Long) {
        val listener = events ?: return
        wake.hold()
        try {
            listener.onHeard(payload, rssi, atEpochMillis)
        } catch (e: Exception) {
            // As in notifyStopped.
        }
    }

    private fun decided(): Boolean {
        val state = central?.state ?: return false
        return state != CBManagerStateUnknown && state != CBManagerStateResetting &&
            CBManager.authorization != CBManagerAuthorizationNotDetermined
    }

    /**
     * Resumes [requestAccess] once iOS has an answer. The state update is the usual signal, but a
     * manager may report "unauthorized" while the prompt is still up and then not report again
     * when the person refuses, so while someone waits the authorization is also checked twice a
     * second.
     */
    private fun checkDecision() {
        if (decisionWaiters.isEmpty()) return
        if (decided()) {
            val waiting = decisionWaiters.toList()
            decisionWaiters.clear()
            waiting.forEach { if (it.isActive) it.resume(Unit) }
            return
        }
        if (decisionPolling) return
        decisionPolling = true
        after(DECISION_POLL_MS) {
            decisionPolling = false
            checkDecision()
        }
    }

    private fun centralStateChanged() {
        val c = central ?: return
        checkDecision()
        val state = c.state
        if (state == CBManagerStatePoweredOn && restoredPeripherals.isNotEmpty()) {
            // Connections iOS kept for the app while it was gone were reads in progress; none is needed now.
            for (p in restoredPeripherals) {
                p.delegate = null
                c.cancelPeripheralConnection(p)
            }
            restoredPeripherals.clear()
        }
        if (!active) {
            // Stopped while the manager could not take commands (after a relaunch, before it was
            // powered on): stop now whatever iOS restored. While a restoration waits for the
            // runtime, it keeps running.
            if (state == CBManagerStatePoweredOn && !restoring && c.isScanning) c.stopScan()
            return
        }
        val reason = stopReasonOf(state)
        when {
            state == CBManagerStatePoweredOn -> {
                startScan()
                pump()
            }
            reason != null -> stopSelf(reason)
            // Unknown or resetting: the connections are gone; wait for the next update.
            else -> reads.clear()?.peripheral?.delegate = null
        }
    }

    private fun peripheralStateChanged() {
        val pm = peripheralManager ?: return
        val state = pm.state
        if (!active) {
            // As in centralStateChanged: no advertising and no service once stopped.
            if (state == CBManagerStatePoweredOn && !restoring) {
                if (pm.isAdvertising) pm.stopAdvertising()
                pm.removeAllServices()
                restoredServices = emptyList()
            }
            return
        }
        val reason = stopReasonOf(state)
        when {
            state == CBManagerStatePoweredOn -> publish()
            reason != null -> stopSelf(reason)
            else -> {
                // Resetting: the GATT database is rebuilt, so the service is added again once powered on.
                service = null
                serviceAdded = false
                addingService = false
            }
        }
    }

    /** Puts the service in the GATT database (or adopts the restored one) and advertises. */
    private fun publish() {
        val pm = peripheralManager ?: return
        val cfg = config ?: return
        if (pm.state != CBManagerStatePoweredOn || addingService) return
        if (!serviceAdded) {
            val restored = restoredServices.firstOrNull { it.UUID.UUIDString.equals(cfg.serviceUuid, ignoreCase = true) && hasToken(it, cfg) }
            restoredServices = emptyList()
            if (restored != null) {
                service = restored
                serviceAdded = true
            } else {
                pm.removeAllServices()
                val characteristic = CBMutableCharacteristic(
                    type = CBUUID.UUIDWithString(cfg.characteristicUuid),
                    properties = CBCharacteristicPropertyRead,
                    value = null,
                    permissions = CBAttributePermissionsReadable,
                )
                val fresh = CBMutableService(type = CBUUID.UUIDWithString(cfg.serviceUuid), primary = true)
                fresh.setCharacteristics(listOf(characteristic))
                service = fresh
                addingService = true
                pm.addService(fresh)
                return
            }
        }
        advertise()
    }

    private fun hasToken(service: CBService, cfg: BleRadioConfig): Boolean =
        service.characteristics?.any { (it as? CBCharacteristic)?.UUID?.UUIDString.equals(cfg.characteristicUuid, ignoreCase = true) } == true

    private fun advertise() {
        val pm = peripheralManager ?: return
        val cfg = config ?: return
        if (pm.state != CBManagerStatePoweredOn || pm.isAdvertising) return
        // The service UUID only: no local name (it would name the phone) and no service data (iOS ignores it).
        pm.startAdvertising(mapOf<Any?, Any?>(CBAdvertisementDataServiceUUIDsKey to listOf(CBUUID.UUIDWithString(cfg.serviceUuid))))
    }

    private fun serviceWasAdded(added: CBService, error: NSError?) {
        if (added != service) return
        addingService = false
        if (!active) return
        if (error != null) {
            stopSelf(BleStopReason.AdvertiseFailed)
            return
        }
        serviceAdded = true
        advertise()
    }

    private fun advertisingStarted(error: NSError?) {
        if (!active || error == null) return
        // Asked twice (after a restoration that kept advertising): not a failure.
        if (error.domain == CBErrorDomain && error.code == CBErrorAlreadyAdvertising) return
        stopSelf(BleStopReason.AdvertiseFailed)
    }

    private fun readRequested(pm: CBPeripheralManager, request: CBATTRequest) {
        val cfg = config
        if (!active || cfg == null) {
            if (restoring) {
                // Relaunched for this very read: the runtime starts the radio in a moment.
                heldReads += pm to request
                if (heldReads.size == 1) {
                    val run = generation
                    after(READ_HOLD_MS) { if (run == generation) answerHeldReads() }
                }
            } else {
                answer(pm, request, answerRead(null, 0))
            }
            return
        }
        if (!request.characteristic.UUID.UUIDString.equals(cfg.characteristicUuid, ignoreCase = true)) {
            pm.respondToRequest(request, CBATTErrorRequestNotSupported)
            return
        }
        val now = clock()
        if (now >= cfg.untilEpochMillis) {
            pm.respondToRequest(request, CBATTErrorUnlikelyError)
            stopSelf(BleStopReason.System)
            return
        }
        val payload = try {
            source?.payloadNow()
        } catch (e: Exception) {
            null
        }
        answer(pm, request, answerRead(payload, request.offset.toLong()))
    }

    private fun answer(pm: CBPeripheralManager, request: CBATTRequest, answer: ReadAnswer) {
        answer.value?.let { request.value = it.toNSData() }
        pm.respondToRequest(request, answer.result)
    }

    /** Answers the reads held during a restoration: with the payload once running, refused otherwise. */
    private fun answerHeldReads() {
        if (heldReads.isEmpty()) return
        val held = heldReads.toList()
        heldReads.clear()
        val wasRestoring = restoring
        restoring = false
        for ((pm, request) in held) readRequested(pm, request)
        restoring = wasRestoring && !active
    }

    private fun startScan() {
        val c = central ?: return
        val cfg = config ?: return
        if (!active || c.state != CBManagerStatePoweredOn) return
        if (c.isScanning) c.stopScan()
        // Duplicates off: one report per phone per scan, which the scan restarts make periodic. In the
        // background iOS ignores the option anyway and coalesces discoveries.
        c.scanForPeripheralsWithServices(
            listOf(CBUUID.UUIDWithString(cfg.serviceUuid)),
            mapOf<Any?, Any?>(CBCentralManagerScanOptionAllowDuplicatesKey to false),
        )
    }

    private fun discovered(peripheral: CBPeripheral, advertisementData: Map<Any?, *>, rssiValue: NSNumber) {
        val cfg = config ?: return
        if (!active) return
        val now = clock()
        if (now >= cfg.untilEpochMillis) {
            stopSelf(BleStopReason.System)
            return
        }
        val rssi = rssiValue.intValue
        if (rssi == RSSI_UNAVAILABLE || rssi < cfg.nearRssi) return
        val serviceData = serviceDataOf(advertisementData, cfg.serviceUuid)
        if (serviceData != null) {
            deliver(serviceData, rssi, now)
            return
        }
        if (!connectableOf(advertisementData)) return
        if (reads.offer(GattReads.Candidate(peripheral.identifier.UUIDString, peripheral, rssi, now))) pump()
    }

    /** Starts the next read when nothing is being read and the cap allows it. */
    private fun pump() {
        val c = central ?: return
        if (!active || c.state != CBManagerStatePoweredOn) return
        when (val next = reads.next(clock())) {
            is GattReads.Next.Start -> {
                val candidate = next.candidate
                candidate.peripheral.delegate = peripheralDelegate
                c.connectPeripheral(candidate.peripheral, null)
                // Core Bluetooth never gives up on a connection by itself.
                after(GattReads.READ_TIMEOUT_MS) { if (reads.current === candidate) endRead() }
            }
            is GattReads.Next.WaitUntil -> if (!pumpScheduled) {
                pumpScheduled = true
                val run = generation
                after((next.epochMillis - clock()).coerceAtLeast(0)) {
                    if (run == generation) {
                        pumpScheduled = false
                        pump()
                    }
                }
            }
            GattReads.Next.Idle -> Unit
        }
    }

    private fun endRead() {
        val done = reads.finish() ?: return
        done.peripheral.delegate = null
        central?.takeIf { it.state == CBManagerStatePoweredOn }?.cancelPeripheralConnection(done.peripheral)
        pump()
    }

    private fun isCurrent(peripheral: CBPeripheral): Boolean = reads.current?.id == peripheral.identifier.UUIDString

    private fun connected(peripheral: CBPeripheral) {
        val cfg = config
        if (!isCurrent(peripheral) || cfg == null) {
            central?.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.discoverServices(listOf(CBUUID.UUIDWithString(cfg.serviceUuid)))
    }

    private fun servicesDiscovered(peripheral: CBPeripheral, error: NSError?) {
        val cfg = config ?: return
        if (!isCurrent(peripheral)) return
        val found = peripheral.services?.firstOrNull { (it as? CBService)?.UUID?.UUIDString.equals(cfg.serviceUuid, ignoreCase = true) } as? CBService
        if (error != null || found == null) {
            endRead()
            return
        }
        peripheral.discoverCharacteristics(listOf(CBUUID.UUIDWithString(cfg.characteristicUuid)), found)
    }

    private fun characteristicsDiscovered(peripheral: CBPeripheral, service: CBService, error: NSError?) {
        val cfg = config ?: return
        if (!isCurrent(peripheral)) return
        val found = service.characteristics?.firstOrNull {
            (it as? CBCharacteristic)?.UUID?.UUIDString.equals(cfg.characteristicUuid, ignoreCase = true)
        } as? CBCharacteristic
        if (error != null || found == null) {
            endRead()
            return
        }
        peripheral.readValueForCharacteristic(found)
    }

    private fun valueRead(peripheral: CBPeripheral, characteristic: CBCharacteristic, error: NSError?) {
        val cfg = config ?: return
        val current = reads.current ?: return
        if (!isCurrent(peripheral)) return
        val value = characteristic.value
        if (error == null && value != null && characteristic.UUID.UUIDString.equals(cfg.characteristicUuid, ignoreCase = true)) {
            // Decoding is the runtime's: it reads v1 and legacy payloads and ignores anything else.
            deliver(value.toByteArray(), current.rssi, clock())
        }
        endRead()
    }

    private fun connectionEnded(peripheral: CBPeripheral) {
        restoredPeripherals.removeAll { it.identifier.UUIDString == peripheral.identifier.UUIDString }
        if (isCurrent(peripheral)) endRead()
    }

    private fun centralRestored(state: Map<Any?, *>) {
        (state[CBCentralManagerRestoredStatePeripheralsKey] as? List<*>)?.forEach { item ->
            (item as? CBPeripheral)?.let { restoredPeripherals += it }
        }
    }

    private fun peripheralManagerRestored(state: Map<Any?, *>) {
        restoredServices = (state[CBPeripheralManagerRestoredStateServicesKey] as? List<*>)?.mapNotNull { it as? CBMutableService }.orEmpty()
    }

    /** Ticks at most every [SCAN_RESTART_MS], at each window change and at the deadline. */
    private fun scheduleTick(run: Int) {
        val cfg = config ?: return
        val now = clock()
        val nextWindow = BleProtocol.windowStartMillis(BleProtocol.windowAtMillis(now) + 1)
        val delay = minOf(SCAN_RESTART_MS, cfg.untilEpochMillis - now, nextWindow - now + WINDOW_MARGIN_MS).coerceAtLeast(MIN_TICK_MS)
        after(delay) { if (run == generation) tick(run) }
    }

    private fun tick(run: Int) {
        val cfg = config ?: return
        if (!active) return
        val now = clock()
        if (now >= cfg.untilEpochMillis) {
            stopSelf(BleStopReason.System)
            return
        }
        reads.roll(now)
        startScan()
        pump()
        scheduleTick(run)
    }

    /**
     * Runs [block] on the queue after [millis] of wall-clock time, so that a deadline is not pushed
     * back by the time the phone slept (a suspended app runs nothing until its next wake, when every
     * overdue timer fires).
     */
    private fun after(millis: Long, block: () -> Unit) {
        platform.darwin.dispatch_after(dispatch_walltime(null, millis * NANOS_PER_MILLI), queue, block)
    }

    // ---------------------------------------------------------------------------------------------
    // Delegates. Core Bluetooth holds its delegates weakly; the radio keeps them. Each callback
    // arrives on the queue.

    private class CentralDelegate(private val radio: IosBleRadio) : NSObject(), CBCentralManagerDelegateProtocol {
        override fun centralManagerDidUpdateState(central: CBCentralManager) = radio.centralStateChanged()

        override fun centralManager(central: CBCentralManager, willRestoreState: Map<Any?, *>) = radio.centralRestored(willRestoreState)

        override fun centralManager(
            central: CBCentralManager,
            didDiscoverPeripheral: CBPeripheral,
            advertisementData: Map<Any?, *>,
            RSSI: NSNumber,
        ) = radio.discovered(didDiscoverPeripheral, advertisementData, RSSI)

        @ObjCSignatureOverride
        override fun centralManager(central: CBCentralManager, didConnectPeripheral: CBPeripheral) = radio.connected(didConnectPeripheral)

        @ObjCSignatureOverride
        override fun centralManager(central: CBCentralManager, didFailToConnectPeripheral: CBPeripheral, error: NSError?) =
            radio.connectionEnded(didFailToConnectPeripheral)

        @ObjCSignatureOverride
        override fun centralManager(central: CBCentralManager, didDisconnectPeripheral: CBPeripheral, error: NSError?) =
            radio.connectionEnded(didDisconnectPeripheral)
    }

    private class PeripheralDelegate(private val radio: IosBleRadio) : NSObject(), CBPeripheralDelegateProtocol {
        override fun peripheral(peripheral: CBPeripheral, didDiscoverServices: NSError?) = radio.servicesDiscovered(peripheral, didDiscoverServices)

        @ObjCSignatureOverride
        override fun peripheral(peripheral: CBPeripheral, didDiscoverCharacteristicsForService: CBService, error: NSError?) =
            radio.characteristicsDiscovered(peripheral, didDiscoverCharacteristicsForService, error)

        @ObjCSignatureOverride
        override fun peripheral(peripheral: CBPeripheral, didUpdateValueForCharacteristic: CBCharacteristic, error: NSError?) =
            radio.valueRead(peripheral, didUpdateValueForCharacteristic, error)
    }

    private class PeripheralManagerDelegate(private val radio: IosBleRadio) : NSObject(), CBPeripheralManagerDelegateProtocol {
        override fun peripheralManagerDidUpdateState(peripheral: CBPeripheralManager) = radio.peripheralStateChanged()

        override fun peripheralManager(peripheral: CBPeripheralManager, willRestoreState: Map<Any?, *>) =
            radio.peripheralManagerRestored(willRestoreState)

        override fun peripheralManager(peripheral: CBPeripheralManager, didAddService: CBService, error: NSError?) =
            radio.serviceWasAdded(didAddService, error)

        override fun peripheralManagerDidStartAdvertising(peripheral: CBPeripheralManager, error: NSError?) = radio.advertisingStarted(error)

        override fun peripheralManager(peripheral: CBPeripheralManager, didReceiveReadRequest: CBATTRequest) =
            radio.readRequested(peripheral, didReceiveReadRequest)
    }

    companion object {
        /** The central manager's state restoration identifier; it must never change between versions. */
        const val CENTRAL_RESTORE_ID = "app.conferencecaddie.ble.central"

        /** The peripheral manager's state restoration identifier; it must never change between versions. */
        const val PERIPHERAL_RESTORE_ID = "app.conferencecaddie.ble.peripheral"

        /**
         * The process's radio. There must be one: Core Bluetooth restores state to the managers with
         * the identifiers above, and two radios would compete for them. Both the app's screens and a
         * relaunch for Bluetooth reach it through [app.conferencecaddie.shared.IosPeopleServices].
         */
        val shared: IosBleRadio by lazy { IosBleRadio() }

        /** The scan restarts this often, so a phone heard once is heard again (with a fresh RSSI). */
        const val SCAN_RESTART_MS = 60_000L

        /** A read request that relaunched the app waits this long for the runtime to start the radio. */
        const val READ_HOLD_MS = 3_000L

        /** After a relaunch for Bluetooth, restored advertising and scanning stop unless the runtime starts the radio within this time. */
        const val RESTORE_GRACE_MS = 30_000L

        private const val DECISION_POLL_MS = 500L
        private const val WINDOW_MARGIN_MS = 500L
        private const val MIN_TICK_MS = 250L
        private const val NANOS_PER_MILLI = 1_000_000L

        /** Core Bluetooth's RSSI when it could not measure one. */
        private const val RSSI_UNAVAILABLE = 127
    }
}
