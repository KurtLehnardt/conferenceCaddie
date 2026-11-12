package app.conferencecaddie

import android.Manifest
import android.app.ActivityManager
import android.app.ForegroundServiceStartNotAllowedException
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import app.conferencecaddie.FakeBleHardware.Companion.ad
import app.conferencecaddie.shared.AndroidPermissions
import app.conferencecaddie.shared.ble.AndroidBleRadio
import app.conferencecaddie.shared.ble.BleAccess
import app.conferencecaddie.shared.ble.BleGattAnswer
import app.conferencecaddie.shared.ble.BleHardware
import app.conferencecaddie.shared.ble.BleHardwareStatus
import app.conferencecaddie.shared.ble.BlePayloadSource
import app.conferencecaddie.shared.ble.BlePermissionKind
import app.conferencecaddie.shared.ble.BleProtocol
import app.conferencecaddie.shared.ble.BleRadioConfig
import app.conferencecaddie.shared.ble.BleRadioEvents
import app.conferencecaddie.shared.ble.BleRadioService
import app.conferencecaddie.shared.ble.BleRadioState
import app.conferencecaddie.shared.ble.BleReadResult
import app.conferencecaddie.shared.ble.BleStopReason
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Bluetooth radio's foreground service through its whole life, on a device or emulator, with
 * [FakeBleHardware] in place of the Bluetooth stack: started, refreshed, read, switched, left running
 * when the activity finishes, and stopped every way it can stop. The service, the notification, the
 * alarms and the process are real; only the radio calls are faked.
 *
 * Bluetooth and notification permissions are granted through the instrumentation and never revoked
 * (revoking one ends the app's process). Starting a foreground service needs the app in front on
 * Android 12 and newer, so every start happens with MainActivity shown.
 */
@RunWith(AndroidJUnit4::class)
class BleServiceLifecycleTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val radio = AndroidBleRadio.get(context, R.drawable.ic_stat_caddie)
    private val notifications = context.getSystemService(NotificationManager::class.java)
    private val fake = FakeBleHardware()

    private lateinit var savedHardware: BleHardware
    private var savedGrace = 0L
    private lateinit var savedClock: () -> Long
    private var savedHook: ((Context) -> Unit)? = null
    private lateinit var savedStartService: (Intent) -> Unit
    private lateinit var savedPermissionGranted: (String) -> Boolean
    private var scenario: ActivityScenario<MainActivity>? = null

    private val nearRssi = -75
    private val serviceUuid = UUID.fromString(BleProtocol.SERVICE_UUID)

    /** A payload source the test changes at will; payloadNow is what the radio must advertise and serve. */
    private class Source(@Volatile var payload: ByteArray?) : BlePayloadSource {
        override fun payloadNow(): ByteArray? = payload?.copyOf()
    }

    private class Events : BleRadioEvents {
        val heard = CopyOnWriteArrayList<Pair<ByteArray, Int>>()
        val stopped = CopyOnWriteArrayList<BleStopReason>()

        override fun onHeard(payload: ByteArray, rssi: Int, atEpochMillis: Long) {
            heard += payload to rssi
        }

        override fun onStopped(reason: BleStopReason) {
            stopped += reason
        }
    }

    private fun payload(seed: Int) = ByteArray(17) { if (it == 0) 1 else (seed * 31 + it).toByte() }

    private fun config(untilEpochMillis: Long = radio.clock() + 3_600_000L, rssi: Int = nearRssi) =
        BleRadioConfig(nearRssi = rssi, untilEpochMillis = untilEpochMillis)

    private fun waitFor(timeoutMillis: Long = 10_000, condition: () -> Boolean): Boolean {
        val until = SystemClock.uptimeMillis() + timeoutMillis
        while (!condition()) {
            if (SystemClock.uptimeMillis() > until) return false
            Thread.sleep(50)
        }
        return true
    }

    private fun onMain(block: () -> Unit) = instrumentation.runOnMainSync(block)

    @Suppress("DEPRECATION") // getRunningServices still lists the app's own services.
    private fun serviceRunning(): Boolean =
        context.getSystemService(ActivityManager::class.java).getRunningServices(Int.MAX_VALUE)
            .any { it.service.className == BleRadioService::class.java.name }

    @Suppress("DEPRECATION")
    private fun serviceInForeground(): Boolean =
        context.getSystemService(ActivityManager::class.java).getRunningServices(Int.MAX_VALUE)
            .any { it.service.className == BleRadioService::class.java.name && it.foreground }

    /** The service's record in the activity manager, which names its foreground service types. */
    private fun dumpsys(): String {
        val pfd = instrumentation.uiAutomation.executeShellCommand(
            "dumpsys activity services ${context.packageName}/${BleRadioService::class.java.name}",
        )
        return ParcelFileDescriptor.AutoCloseInputStream(pfd).use { it.readBytes().decodeToString() }
    }

    private fun ongoing(): Notification? =
        notifications.activeNotifications.firstOrNull { it.id == ONGOING_ID && it.packageName == context.packageName }?.notification

    private fun showApp() {
        if (scenario == null) scenario = ActivityScenario.launch(MainActivity::class.java)
    }

    /** Starts the radio with the app in front and waits until the service advertises. */
    private fun startRunning(source: Source, events: Events, config: BleRadioConfig = config()) {
        showApp()
        radio.start(config, source, events)
        assertTrue("the service advertises", waitFor { fake.advertising != null && serviceInForeground() })
    }

    @Before
    fun setUp() {
        val ui = instrumentation.uiAutomation
        if (Build.VERSION.SDK_INT >= 31) {
            for (p in listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT)) {
                ui.grantRuntimePermission(context.packageName, p)
            }
        } else {
            ui.grantRuntimePermission(context.packageName, Manifest.permission.ACCESS_FINE_LOCATION)
        }
        if (Build.VERSION.SDK_INT >= 33) ui.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        radio.stop()
        assertTrue(waitFor { !serviceRunning() })
        savedHardware = radio.hardware
        savedGrace = radio.restartGraceMillis
        savedClock = radio.clock
        savedHook = AndroidBleRadio.onSystemRestart
        savedStartService = radio.startService
        savedPermissionGranted = radio.permissionGranted
        radio.hardware = fake
    }

    @After
    fun tearDown() {
        radio.stop()
        waitFor { !serviceRunning() }
        if (!::savedHardware.isInitialized) return
        radio.hardware = savedHardware
        radio.restartGraceMillis = savedGrace
        radio.clock = savedClock
        AndroidBleRadio.onSystemRestart = savedHook
        radio.startService = savedStartService
        radio.permissionGranted = savedPermissionGranted
        scenario?.close()
        scenario = null
        // A tapped notification may have opened another MainActivity; none is left for the next test.
        onMain {
            val monitor = ActivityLifecycleMonitorRegistry.getInstance()
            for (stage in listOf(Stage.RESUMED, Stage.PAUSED, Stage.STARTED, Stage.STOPPED, Stage.CREATED)) {
                monitor.getActivitiesInStage(stage).forEach { it.finish() }
            }
        }
    }

    @Test
    fun accessAndStateWithEveryPermissionGranted() {
        assertEquals(BleAccess.Granted, radio.access())
        assertEquals(if (Build.VERSION.SDK_INT >= 31) BlePermissionKind.NearbyDevices else BlePermissionKind.Location, radio.permissionKind)
        assertTrue(radio.supported)
        assertEquals(BleRadioState.Ready, radio.state())
        fake.enabled = false
        assertEquals(BleRadioState.PoweredOff, radio.state())
        assertTrue("extended advertising is checked again once Bluetooth is on", radio.supported)
        fake.enabled = true
        fake.extended = false
        assertEquals(BleRadioState.Unsupported, radio.state())
        assertFalse(radio.supported)
        fake.present = false
        assertEquals(BleRadioState.Unsupported, radio.state())
        assertFalse(radio.supported)
    }

    @Test
    fun startRunsInTheForegroundAndAdvertisesThePayload() {
        val source = Source(payload(1))
        val events = Events()
        assertFalse(radio.running)
        startRunning(source, events)
        assertTrue(radio.running)

        assertArrayEquals(source.payloadNow(), fake.advertising)
        assertEquals(serviceUuid, fake.advertisingUuid)
        assertEquals(serviceUuid to UUID.fromString(BleProtocol.TOKEN_CHARACTERISTIC_UUID), fake.gattUuids)
        assertNotNull("the scan runs", fake.scanListener)

        // A foreground service of type connectedDevice (0x10), as the activity manager records it.
        val record = dumpsys().lines().firstOrNull { "isForeground=" in it }.orEmpty()
        assertTrue(record, "isForeground=true" in record)
        if (Build.VERSION.SDK_INT >= 29) assertTrue(record, Regex("types=(0x)?0*10\\b").containsMatchIn(record))

        // Its notification: its own quiet channel, the words, a Stop action and a tap to who is around.
        assertTrue(waitFor { ongoing() != null })
        val n = ongoing()!!
        assertEquals("finding_people", n.channelId)
        val channel = notifications.getNotificationChannel(n.channelId)
        assertEquals("Finding people near you", channel.name)
        assertEquals(NotificationManager.IMPORTANCE_LOW, channel.importance)
        assertEquals("Conference Caddie is finding people near you", n.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals(
            "Your phone broadcasts a random code and listens for others. Nothing about you is sent over Bluetooth.",
            n.extras.getCharSequence(Notification.EXTRA_TEXT).toString(),
        )
        assertTrue(n.flags and Notification.FLAG_FOREGROUND_SERVICE != 0)
        assertEquals("Stop", n.actions.single().title.toString())
        assertNotNull(n.contentIntent)
        assertTrue(events.stopped.isEmpty())
    }

    @Test
    fun theNotificationOpensWhoIsAround() {
        val taps = CopyOnWriteArrayList<String>()
        val watch = IncomingLinks.watch(taps)
        // Started the way the launcher starts it, in the app's own task, so the tap reaches it through
        // onNewIntent (ActivityScenario would put it in the test's task, and a tap would open a second).
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)!!.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val activity = instrumentation.startActivitySync(launch)
        try {
            radio.start(config(), Source(payload(1)), Events())
            assertTrue(waitFor { fake.advertising != null && ongoing() != null })
            // The tap carries the app's tap key, so the exported activity hands the link on.
            ongoing()!!.contentIntent.send()
            assertTrue(waitFor { taps.contains("caddie://people?around=1") })
        } finally {
            watch.cancel()
            activity.finish()
        }
    }

    @Test
    fun refreshRestartsTheSetsWithTheNewPayload() {
        val source = Source(payload(1))
        startRunning(source, Events())
        val before = fake.advertised.size
        source.payload = payload(2)
        radio.refresh()
        assertTrue(waitFor { fake.advertised.size > before })
        assertArrayEquals(payload(2), fake.advertising)
        // Refreshing restarts only the advertising sets: the scan and the GATT server keep running.
        assertEquals(1, fake.scanStarts)
        assertEquals(1, fake.gattOpens)

        // A second refresh with the same payload (the runtime and the service's own timer both
        // refresh at a window start) leaves the running sets alone.
        val restarts = fake.advertised.size
        radio.refresh()
        Thread.sleep(500)
        assertEquals(restarts, fake.advertised.size)

        // No key for a moment: nothing is advertised rather than a stale payload, and the scan goes on.
        source.payload = null
        radio.refresh()
        assertTrue(waitFor { fake.advertising == null })
        assertNotNull(fake.scanListener)
        assertTrue(radio.running)
        source.payload = payload(3)
        radio.refresh()
        assertTrue(waitFor { fake.advertising?.contentEquals(payload(3)) == true })
    }

    @Test
    fun aNewWindowSeenByTheScanRefreshesByItself() {
        // The radio's clock, moved by the test: 30 seconds into window 2990520.
        var now = BleProtocol.windowStartMillis(2990520L) + 30_000L
        radio.clock = { now }
        val source = BlePayloadSource { BleProtocol.encodePayload(ByteArray(16) { (BleProtocol.windowAtMillis(now) % 100).toByte() }) }
        val events = Events()
        showApp()
        radio.start(config(untilEpochMillis = now + 3_600_000L), source, events)
        assertTrue(waitFor { fake.advertising != null })
        assertEquals(20.toByte(), fake.advertising!![1])

        now = BleProtocol.windowStartMillis(2990521L) + 5L
        onMain { fake.scanListener!!.onAdvertisements(listOf(ad("AA:00:00:00:00:01", -90))) }
        assertTrue(waitFor { fake.advertising?.get(1) == 21.toByte() })
        assertTrue(events.stopped.isEmpty())
    }

    @Test
    fun gattReadsAreAnsweredWithThePayloadFromTheOffset() {
        val source = Source(payload(7))
        startRunning(source, Events())
        val reader = fake.reader!!
        // Called on a binder thread in the real stack; here on the test's thread, which is not main.
        val whole = reader.read(0)
        assertEquals(BleGattAnswer.SUCCESS, whole.status)
        assertArrayEquals(payload(7), whole.value)
        val tail = reader.read(5)
        assertEquals(BleGattAnswer.SUCCESS, tail.status)
        assertArrayEquals(payload(7).copyOfRange(5, 17), tail.value)
        assertEquals(0, reader.read(17).value!!.size)
        assertEquals(BleGattAnswer.INVALID_OFFSET, reader.read(18).status)
        // The payload of the moment, not the one advertised at the start.
        source.payload = payload(8)
        assertArrayEquals(payload(8), reader.read(0).value)
        source.payload = null
        assertEquals(BleGattAnswer.FAILURE, reader.read(0).status)
    }

    @Test
    fun serviceDataIsReportedAndAnIPhoneIsReadOverGatt() {
        val events = Events()
        startRunning(Source(payload(1)), events)
        val android = payload(40)
        val iphone = payload(41)
        onMain {
            fake.scanListener!!.onAdvertisements(
                listOf(
                    // An Android phone: the payload is in its service data.
                    ad("AA:00:00:00:00:02", -60, serviceData = android, advertisesService = true),
                    // Too far away to count, payload or not.
                    ad("AA:00:00:00:00:03", -90, serviceData = payload(42), advertisesService = true),
                    // A backgrounded iPhone: Apple data starting with the overflow type.
                    ad("AA:00:00:00:00:04", -55, appleData = byteArrayOf(0x01, 0, 0, 0, 0x40)),
                    // Apple data, but not connectable: never read.
                    ad("AA:00:00:00:00:05", -50, appleData = byteArrayOf(0x01), connectable = false),
                ),
            )
        }
        assertTrue(waitFor { events.heard.isNotEmpty() })
        assertArrayEquals(android, events.heard.single().first)
        assertEquals(-60, events.heard.single().second)

        assertTrue(waitFor { fake.interrogated.isNotEmpty() })
        assertEquals(listOf("AA:00:00:00:00:04"), fake.interrogated.toList())
        onMain { fake.pendingRead!!(BleReadResult.Value(iphone)) }
        assertTrue(waitFor { events.heard.size == 2 })
        assertArrayEquals(iphone, events.heard[1].first)
        assertEquals(-55, events.heard[1].second)

        // Read once in this window: heard again, it is not connected to again.
        onMain { fake.scanListener!!.onAdvertisements(listOf(ad("AA:00:00:00:00:04", -50, appleData = byteArrayOf(0x01)))) }
        instrumentation.waitForIdleSync()
        assertEquals(1, fake.interrogated.size)
    }

    @Test
    fun startingAgainSwitchesTheRunningServiceInPlace() {
        val first = Events()
        startRunning(Source(payload(1)), first)
        val second = Events()
        radio.start(config(rssi = -60), Source(payload(2)), second)
        assertTrue(waitFor { fake.advertising?.contentEquals(payload(2)) == true })
        // The same scan and GATT server; only the advertising sets restart.
        assertEquals(1, fake.scanStarts)
        assertEquals(1, fake.gattOpens)
        // The new events receive what is heard, with the new threshold.
        onMain {
            fake.scanListener!!.onAdvertisements(
                listOf(ad("AA:00:00:00:00:06", -70, serviceData = payload(50)), ad("AA:00:00:00:00:07", -59, serviceData = payload(51))),
            )
        }
        assertTrue(waitFor { second.heard.isNotEmpty() })
        assertArrayEquals(payload(51), second.heard.single().first)
        assertTrue(first.heard.isEmpty())
        assertTrue(first.stopped.isEmpty() && second.stopped.isEmpty())
    }

    @Test
    fun finishingTheActivityLeavesTheServiceRunning() {
        val events = Events()
        val source = Source(payload(1))
        startRunning(source, events)
        scenario?.close()
        scenario = null
        Thread.sleep(2_000)
        assertTrue(serviceInForeground())
        assertTrue(radio.running)
        assertNotNull(fake.advertising)
        assertNotNull(fake.scanListener)
        assertNotNull(ongoing())
        assertTrue(events.stopped.isEmpty())
        // From the background, a refresh with a new payload still reaches it.
        source.payload = payload(2)
        radio.refresh()
        assertTrue(waitFor { fake.advertised.size >= 2 })
    }

    @Test
    fun theStopActionStopsWithUser() {
        val events = Events()
        startRunning(Source(payload(1)), events)
        assertTrue(waitFor { ongoing() != null })
        ongoing()!!.actions.single().actionIntent.send()
        assertTrue(waitFor { events.stopped.isNotEmpty() })
        assertEquals(listOf(BleStopReason.User), events.stopped.toList())
        assertTrue(waitFor { !serviceRunning() })
        assertFalse(radio.running)
        assertTrue(fake.idle)
        assertTrue(waitFor { ongoing() == null })
    }

    @Test
    fun theSessionsEndStopsWithSystem() {
        val events = Events()
        // The app is shown first: the end is counted from the start, not from before the activity came up.
        showApp()
        startRunning(Source(payload(1)), events, config(untilEpochMillis = radio.clock() + 3_000L))
        assertTrue(waitFor { events.stopped.isNotEmpty() })
        assertEquals(listOf(BleStopReason.System), events.stopped.toList())
        assertTrue(waitFor { !serviceRunning() })
        assertFalse(radio.running)
        assertTrue(fake.idle)
    }

    @Test
    fun anEndAlreadyPastStopsAtOnce() {
        val events = Events()
        showApp()
        radio.start(config(untilEpochMillis = radio.clock() - 1L), Source(payload(1)), events)
        assertTrue(waitFor { events.stopped.isNotEmpty() })
        assertEquals(listOf(BleStopReason.System), events.stopped.toList())
        assertTrue(waitFor { !serviceRunning() })
    }

    @Test
    fun bluetoothSwitchedOffStopsWithBluetoothOff() {
        val events = Events()
        startRunning(Source(payload(1)), events)
        onMain { fake.onAdapterOff!!() }
        assertTrue(waitFor { events.stopped.isNotEmpty() })
        assertEquals(listOf(BleStopReason.BluetoothOff), events.stopped.toList())
        assertTrue(waitFor { !serviceRunning() })
        assertTrue(fake.idle)
    }

    @Test
    fun bluetoothOffAtTheStartStopsWithBluetoothOff() {
        fake.enabled = false
        val events = Events()
        showApp()
        radio.start(config(), Source(payload(1)), events)
        assertTrue(waitFor { events.stopped.isNotEmpty() })
        assertEquals(listOf(BleStopReason.BluetoothOff), events.stopped.toList())
        assertTrue(waitFor { !serviceRunning() })
    }

    @Test
    fun noExtendedAdvertisingStopsWithUnsupported() {
        fake.extended = false
        val events = Events()
        showApp()
        radio.start(config(), Source(payload(1)), events)
        assertTrue(waitFor { events.stopped.isNotEmpty() })
        assertEquals(listOf(BleStopReason.Unsupported), events.stopped.toList())
        assertTrue(waitFor { !serviceRunning() })
    }

    @Test
    fun advertisingFailuresStopWithAdvertiseFailed() {
        val events = Events()
        startRunning(Source(payload(1)), events)
        // The controller gives up on a set after accepting it.
        onMain { fake.onAdvertiseFailed!!() }
        assertTrue(waitFor { events.stopped.isNotEmpty() })
        assertEquals(listOf(BleStopReason.AdvertiseFailed), events.stopped.toList())
        assertTrue(waitFor { !serviceRunning() })

        // The stack refuses the set outright.
        fake.advertiseStatus = BleHardwareStatus.Failed
        val again = Events()
        radio.start(config(), Source(payload(1)), again)
        assertTrue(waitFor { again.stopped.isNotEmpty() })
        assertEquals(listOf(BleStopReason.AdvertiseFailed), again.stopped.toList())

        // A missing permission is reported as such.
        fake.advertiseStatus = BleHardwareStatus.NoPermission
        val third = Events()
        radio.start(config(), Source(payload(1)), third)
        assertTrue(waitFor { third.stopped.isNotEmpty() })
        assertEquals(listOf(BleStopReason.PermissionLost), third.stopped.toList())
        assertTrue(waitFor { !serviceRunning() })
    }

    @Test
    fun stopIsQuietAndIdempotent() {
        radio.stop()
        val events = Events()
        startRunning(Source(payload(1)), events)
        radio.stop()
        radio.stop()
        assertFalse(radio.running)
        assertTrue(waitFor { !serviceRunning() })
        assertTrue(fake.idle)
        Thread.sleep(500)
        assertTrue("stop() is not reported as a stop by itself", events.stopped.isEmpty())
        // Started and stopped before the service has even come up: it comes up and goes again.
        radio.start(config(), Source(payload(2)), events)
        radio.stop()
        Thread.sleep(1_000)
        assertTrue(waitFor { !serviceRunning() })
        assertFalse(radio.running)
        assertTrue(events.stopped.isEmpty())
    }

    @Test
    fun aRestartWithNothingToResumeCallsTheHookAndStopsAfterTheGrace() {
        val calls = AtomicInteger()
        AndroidBleRadio.onSystemRestart = { calls.incrementAndGet() }
        radio.restartGraceMillis = 1_500L
        showApp()
        // What the system does after ending the process: a start without an action (the service
        // treats no intent and an intent without an action alike).
        context.startForegroundService(Intent(context, BleRadioService::class.java))
        assertTrue(waitFor { calls.get() == 1 })
        assertTrue(waitFor { serviceInForeground() })
        assertTrue(waitFor(timeoutMillis = 10_000) { !serviceRunning() })
        assertEquals(1, calls.get())
        assertTrue(fake.idle)
    }

    @Test
    fun aRestartResumesWhenTheRuntimeStartsTheRadioAgain() {
        val events = Events()
        val source = Source(payload(9))
        // The hook stands in for the people features, whose runtime restores the session.
        AndroidBleRadio.onSystemRestart = { radio.start(config(), source, events) }
        radio.restartGraceMillis = 1_500L
        showApp()
        context.startForegroundService(Intent(context, BleRadioService::class.java))
        assertTrue(waitFor { fake.advertising != null })
        assertArrayEquals(payload(9), fake.advertising)
        Thread.sleep(2_500)
        assertTrue("past the grace, still running", serviceInForeground())
        assertTrue(radio.running)
        assertTrue(events.stopped.isEmpty())
    }

    @Test
    fun aStopDuringTheRestartGraceStopsTheRestoredSessionWithUser() {
        // Nothing restores the session yet: the runtime is still opening the database.
        AndroidBleRadio.onSystemRestart = {}
        radio.restartGraceMillis = 10_000L
        showApp()
        context.startForegroundService(Intent(context, BleRadioService::class.java))
        assertTrue(waitFor { serviceInForeground() && ongoing() != null })
        // The person taps Stop in the notification of the restarted service.
        ongoing()!!.actions.single().actionIntent.send()
        assertTrue(waitFor { !serviceRunning() })
        assertFalse(radio.running)

        // The runtime restores its session: it stops at once with User, so the runtime turns
        // Bluetooth proximity off and tells the server, as a Stop in a running service would.
        val events = Events()
        radio.start(config(), Source(payload(1)), events)
        assertTrue(waitFor { events.stopped.isNotEmpty() })
        assertEquals(listOf(BleStopReason.User), events.stopped.toList())
        assertFalse(radio.running)
        assertTrue("nothing was advertised", fake.advertised.isEmpty())
        Thread.sleep(500)
        assertFalse(serviceRunning())

        // The Stop counts once: the next start runs.
        val again = Events()
        startRunning(Source(payload(2)), again)
        assertTrue(again.stopped.isEmpty())
    }

    @Test
    fun aStopWithNoServiceCountsForTheGraceOnly() {
        showApp()
        // A Stop from a notification left over in a process where no service runs.
        val stop = Intent(context, BleRadioService::class.java).setAction(STOP_ACTION)
        radio.restartGraceMillis = 10_000L
        context.startService(stop)
        Thread.sleep(1_000)
        assertTrue(waitFor { !serviceRunning() })
        val events = Events()
        radio.start(config(), Source(payload(1)), events)
        assertTrue(waitFor { events.stopped.isNotEmpty() })
        assertEquals(listOf(BleStopReason.User), events.stopped.toList())

        // Past the grace, a Stop that found nothing is forgotten.
        radio.restartGraceMillis = 300L
        context.startService(stop)
        Thread.sleep(1_500)
        assertTrue(waitFor { !serviceRunning() })
        val later = Events()
        startRunning(Source(payload(2)), later)
        Thread.sleep(500)
        assertTrue(later.stopped.isEmpty())
        assertTrue(radio.running)
    }

    @Test
    fun aStopThatFoundNothingIsForgottenWhenTheRuntimeStopsTheRadio() {
        showApp()
        // A Stop from a notification left over, then a restore that resumes nothing (the runtime
        // stops the radio): a session the person starts by hand afterwards keeps running.
        val stop = Intent(context, BleRadioService::class.java).setAction(STOP_ACTION)
        radio.restartGraceMillis = 10_000L
        context.startService(stop)
        Thread.sleep(1_000)
        assertTrue(waitFor { !serviceRunning() })
        radio.stop()
        val events = Events()
        startRunning(Source(payload(1)), events)
        Thread.sleep(500)
        assertTrue(events.stopped.isEmpty())
        assertTrue(radio.running)
    }

    @Test
    fun aStartRefusedInTheBackgroundWaitsForTheForeground() {
        assumeTrue("Android 12 and newer refuse a start from the background", Build.VERSION.SDK_INT >= 31)
        val refusals = AtomicInteger()
        // What Android 12 and newer do when a cold start in the background (the nudge job) restores
        // a session: refuse the foreground service.
        radio.startService = {
            refusals.incrementAndGet()
            throw ForegroundServiceStartNotAllowedException("refused in the background (test)")
        }
        val events = Events()
        radio.start(config(), Source(payload(1)), events)
        assertTrue(waitFor { refusals.get() == 1 })
        Thread.sleep(500)
        assertTrue("a refusal in the background is not a stop", events.stopped.isEmpty())
        assertTrue(radio.running)
        assertFalse(serviceRunning())

        // Still in the background: still waiting.
        radio.resumeDeferred()
        assertTrue(waitFor { refusals.get() == 2 })
        assertTrue(events.stopped.isEmpty())

        // An activity starts (CaddieApplication tells the radio): the service starts for the session.
        radio.startService = savedStartService
        showApp()
        assertTrue(waitFor { fake.advertising != null && serviceInForeground() })
        assertArrayEquals(payload(1), fake.advertising)
        assertTrue(events.stopped.isEmpty())
        assertEquals(2, refusals.get())
    }

    @Test
    fun anotherStartFailureStillStopsWithSystem() {
        radio.startService = { throw IllegalStateException("not a background refusal (test)") }
        val events = Events()
        radio.start(config(), Source(payload(1)), events)
        assertTrue(waitFor { events.stopped.isNotEmpty() })
        assertEquals(listOf(BleStopReason.System), events.stopped.toList())
        assertFalse(radio.running)
    }

    @Test
    fun startsAndStopsInQuickSuccessionNeverStopBeforeTheForeground() {
        // A stop posted between the service's creation and its start command used to stop it before
        // startForeground, which Android punishes by ending the app (and this test run with it).
        showApp()
        val events = Events()
        repeat(8) { i ->
            radio.start(config(), Source(payload(i)), events)
            if (i > 0) Thread.sleep(i * 4L)
            radio.stop()
        }
        assertTrue(waitFor { !serviceRunning() })
        assertTrue(events.stopped.isEmpty())
        startRunning(Source(payload(20)), events)
        assertTrue(events.stopped.isEmpty())
    }

    @Test
    fun swipingTheAppFromRecentsLeavesTheServiceRunning() {
        // In the app's own task, as the launcher starts it, so removing the task is a swipe.
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)!!.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val activity = instrumentation.startActivitySync(launch)
        val events = Events()
        val source = Source(payload(1))
        radio.start(config(), source, events)
        assertTrue(waitFor { fake.advertising != null && serviceInForeground() })
        context.getSystemService(ActivityManager::class.java).appTasks.forEach { it.finishAndRemoveTask() }
        assertTrue(waitFor { activity.isDestroyed })
        Thread.sleep(2_000)
        assertTrue(serviceInForeground())
        assertTrue(radio.running)
        assertArrayEquals(payload(1), fake.advertising)
        assertNotNull(fake.scanListener)
        assertNotNull(ongoing())
        assertTrue(events.stopped.isEmpty())
    }

    @Test
    fun aRefusedRefreshIsTriedOnceMore() {
        val source = Source(payload(1))
        val events = Events()
        startRunning(source, events)

        // The stack refuses the new sets once: a second later they are tried again, and run.
        fake.advertiseStatus = BleHardwareStatus.Failed
        source.payload = payload(2)
        val before = fake.advertiseAttempts
        radio.refresh()
        assertTrue(waitFor { fake.advertiseAttempts > before })
        fake.advertiseStatus = BleHardwareStatus.Ok
        assertTrue(waitFor { fake.advertising?.contentEquals(payload(2)) == true })
        assertTrue(events.stopped.isEmpty())
        assertTrue(radio.running)

        // A set the controller gives up on after a refresh accepted it is tried again too.
        source.payload = payload(3)
        radio.refresh()
        assertTrue(waitFor { fake.advertising?.contentEquals(payload(3)) == true })
        onMain { fake.onAdvertiseFailed!!() }
        assertTrue(waitFor { fake.advertised.count { it.contentEquals(payload(3)) } == 2 })
        assertTrue(events.stopped.isEmpty())

        // Refused again on the retry: the session ends as before.
        fake.advertiseStatus = BleHardwareStatus.Failed
        source.payload = payload(4)
        val attempts = fake.advertiseAttempts
        radio.refresh()
        assertTrue(waitFor { events.stopped.isNotEmpty() })
        assertEquals(listOf(BleStopReason.AdvertiseFailed), events.stopped.toList())
        assertEquals(attempts + 2, fake.advertiseAttempts)
        assertTrue(waitFor { !serviceRunning() })
    }

    @Test
    fun askingWithNoAnswerFromTheSystemIsNotAsking() {
        val prefs = context.getSharedPreferences("caddie_permissions", Context.MODE_PRIVATE)
        val saved = prefs.all.filterKeys { it == "ble_asked" || it == "location_asked" }
        prefs.edit().remove("ble_asked").remove("location_asked").commit()
        radio.permissionGranted = { false }
        // A host attached and detached again leaves none attached, as when no activity exists.
        val gone = host(rationale = false) {}
        AndroidPermissions.attach(gone)
        AndroidPermissions.detach(gone, finishing = true)
        val dismissed = host(rationale = false) { AndroidPermissions.deliver(emptyMap()) }
        val refused = host(rationale = false) { asked -> AndroidPermissions.deliver(asked.associateWith { false }) }
        try {
            assertEquals(BleAccess.NotAsked, radio.access())
            // No activity: nothing was shown, so nothing was asked.
            assertEquals(BleAccess.NotAsked, runBlocking { radio.requestAccess() })
            // An activity now says no rationale is due, as Android says of a permission never
            // asked for: the state is still "not asked", not "refused for good".
            AndroidPermissions.attach(dismissed)
            assertEquals(BleAccess.NotAsked, radio.access())
            // A prompt dismissed without a choice answers nothing: still not asked.
            assertEquals(BleAccess.NotAsked, runBlocking { radio.requestAccess() })
            // A real answer counts: refused with no rationale due is refused for good.
            AndroidPermissions.attach(refused)
            assertEquals(BleAccess.Blocked, runBlocking { radio.requestAccess() })
        } finally {
            AndroidPermissions.detach(dismissed, finishing = false)
            AndroidPermissions.detach(refused, finishing = false)
            val editor = prefs.edit().remove("ble_asked").remove("location_asked")
            saved.forEach { (k, v) -> editor.putBoolean(k, v as Boolean) }
            editor.commit()
        }
    }

    /** A stand-in for the activity's permission host. */
    private fun host(rationale: Boolean, onLaunch: (List<String>) -> Unit) = object : AndroidPermissions.Host {
        override fun launch(permissions: Array<String>) = onLaunch(permissions.toList())
        override fun shouldShowRationale(permission: String) = rationale
    }

    private companion object {
        const val ONGOING_ID = 4101

        /** BleRadioService.ACTION_STOP, internal to the shared module. */
        const val STOP_ACTION = "app.conferencecaddie.ble.STOP"
    }
}
