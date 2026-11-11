package app.conferencecaddie

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationManager
import android.location.provider.ProviderProperties
import android.os.Build
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import app.conferencecaddie.shared.AndroidLocationProvider
import app.conferencecaddie.shared.AndroidNotifier
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.NotificationTaps
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.onSubscription
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The notifier, the notification tap routing through MainActivity and the location provider on a
 * device or emulator. Permissions are granted through the instrumentation, never revoked (revoking
 * one ends the app's process).
 */
@RunWith(AndroidJUnit4::class)
class PlatformServicesTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    private fun grant(vararg permissions: String) {
        for (p in permissions) instrumentation.uiAutomation.grantRuntimePermission(context.packageName, p)
    }

    // Every link MainActivity hands to NotificationTaps during the test. The replay cache cannot
    // tell: the app clears it as soon as it has routed a tap, which it does at once when the backend
    // it reaches offers people features.
    private val taps = CopyOnWriteArrayList<String>()
    private var tapWatch: Job? = null

    private fun lastTap(): String? = taps.lastOrNull()

    private fun waitFor(condition: () -> Boolean) {
        val until = SystemClock.uptimeMillis() + 5_000
        while (!condition() && SystemClock.uptimeMillis() < until) Thread.sleep(50)
    }

    @Before
    fun setUp() {
        NotificationTaps.handled()
        val watching = CompletableDeferred<Unit>()
        tapWatch = CoroutineScope(Dispatchers.Default).launch {
            NotificationTaps.taps.onSubscription { watching.complete(Unit) }.collect { taps += it }
        }
        runBlocking { withTimeout(5_000) { watching.await() } }
    }

    @After
    fun tearDown() {
        tapWatch?.cancel()
    }

    @Test
    fun aTappedNudgeReachesTheRunningActivity() {
        if (Build.VERSION.SDK_INT >= 33) grant(Manifest.permission.POST_NOTIFICATIONS)
        val manager = context.getSystemService(NotificationManager::class.java)
        val notifier = AndroidNotifier(context, R.drawable.ic_stat_caddie)
        // Started the way the launcher starts it, in the app's own task (ActivityScenario would put
        // it in the test's task, where a tap starts a second task instead).
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)!!
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val activity = instrumentation.startActivitySync(launch) as MainActivity
        try {
            assertTrue(runBlocking { notifier.requestPermission() })
            notifier.show("test-nudge", "Conference Caddie", "Someone who's worked on Kubernetes is right near you", "caddie://people?around=1")
            waitFor { manager.activeNotifications.any { it.tag == "test-nudge" } }
            val posted = manager.activeNotifications.single { it.tag == "test-nudge" }
            assertEquals(AndroidNotifier.CHANNEL_ID, posted.notification.channelId)
            assertEquals("Nudges", manager.getNotificationChannel(AndroidNotifier.CHANNEL_ID).name)

            posted.notification.contentIntent.send()
            waitFor { lastTap() == "caddie://people?around=1" }
            assertEquals("caddie://people?around=1", lastTap())

            // The running activity took the tap through onNewIntent; no second one was started.
            instrumentation.waitForIdleSync()
            var resumed: Collection<Activity> = emptyList()
            instrumentation.runOnMainSync {
                resumed = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).toList()
            }
            assertEquals(listOf<Activity>(activity), resumed.toList())

            notifier.cancel("test-nudge")
            waitFor { manager.activeNotifications.none { it.tag == "test-nudge" } }
            assertTrue(manager.activeNotifications.none { it.tag == "test-nudge" })
        } finally {
            activity.finish()
        }
    }

    @Test
    fun aColdStartFromATapDeliversTheLink() {
        // The extras of the notifier's own tap intent: the link and this install's tap key.
        val tap = AndroidNotifier(context, R.drawable.ic_stat_caddie).tapIntent("cold-start", "caddie://inbox")!!
        val intent = Intent(context, MainActivity::class.java).putExtras(tap)
        ActivityScenario.launch<MainActivity>(intent).use {
            waitFor { lastTap() != null }
            assertEquals("caddie://inbox", lastTap())
        }
    }

    @Test
    fun aForeignLinkIsIgnored() {
        val intent = Intent(context, MainActivity::class.java)
            .putExtra(AndroidNotifier.EXTRA_DEEP_LINK, "https://example.org/phish")
        ActivityScenario.launch<MainActivity>(intent).use {
            Thread.sleep(500)
            assertNull(lastTap())
        }
    }

    @Test
    fun positionsFlowWithPreciseAccess() = runBlocking {
        assumeTrue("Test providers with ProviderProperties need Android 12", Build.VERSION.SDK_INT >= 31)
        val lm = context.getSystemService(LocationManager::class.java)
        assumeTrue("Location is switched off on this device", lm.isLocationEnabled)
        grant(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        val provider = AndroidLocationProvider(context)
        assertEquals(LocationAccess.Precise, provider.access())

        // Test providers stand in for the hardware: every one of fused, GPS and network that the
        // device has, so the positions arrive whichever of them the provider listens to (the fused
        // one on Android 12 and newer, which some emulator images back with Play services).
        val names = listOf(LocationManager.FUSED_PROVIDER, LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter { it in lm.allProviders }
        instrumentation.uiAutomation.executeShellCommand("appops set ${context.packageName} android:mock_location allow").close()
        Thread.sleep(300)
        for (name in names) {
            lm.addTestProvider(name, ProviderProperties.Builder().setAccuracy(ProviderProperties.ACCURACY_FINE).build())
            lm.setTestProviderEnabled(name, true)
        }
        // Android limits the positions a background app receives to a few an hour, and the app reads
        // positions only while its screens are shown, so the test does the same: with the activity in
        // front.
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            val first = async(Dispatchers.Default) { provider.fixes().first() }
            val fix = withTimeout(30_000) {
                // Keep reporting until the collection has started and taken one.
                while (!first.isCompleted) {
                    for (name in names) lm.setTestProviderLocation(name, location(name))
                    delay(500)
                }
                first.await()
            }
            assertEquals(37.7749, fix.lat, 1e-6)
            assertEquals(-122.4194, fix.lon, 1e-6)
            assertEquals(12.0, fix.accuracyM, 1e-6)
            assertNotNull(fix.atEpochMillis)
        } finally {
            scenario.close()
            for (name in names) runCatching { lm.removeTestProvider(name) }
            instrumentation.uiAutomation.executeShellCommand("appops set ${context.packageName} android:mock_location default").close()
        }
    }

    private fun location(provider: String) = Location(provider).apply {
        latitude = 37.7749
        longitude = -122.4194
        accuracy = 12f
        time = System.currentTimeMillis()
        elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
    }
}
