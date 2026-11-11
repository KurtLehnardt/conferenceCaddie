package app.conferencecaddie

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.conferencecaddie.shared.AndroidNotifier
import app.conferencecaddie.shared.NotificationTaps
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.onSubscription
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * MainActivity is exported, so any installed app can start it with a deep link extra. Only an
 * intent that carries this install's tap key, which only the notifier's own PendingIntents carry,
 * counts as a notification tap; anything else opens the app and nothing more.
 */
@RunWith(AndroidJUnit4::class)
class NotificationTapTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val notifier = AndroidNotifier(context, R.drawable.ic_stat_caddie)
    private val nudge = "caddie://people?around=1"

    private val taps = CopyOnWriteArrayList<String>()
    private var tapWatch: Job? = null

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

    private fun key(): String = notifier.tapIntent("key", nudge)!!.getStringExtra(AndroidNotifier.EXTRA_TAP_KEY)!!

    /** An intent another app could send: the activity, the link and, when given, a tap key. */
    private fun forged(link: String, key: String? = null): Intent =
        Intent(context, MainActivity::class.java).putExtra(AndroidNotifier.EXTRA_DEEP_LINK, link).also {
            if (key != null) it.putExtra(AndroidNotifier.EXTRA_TAP_KEY, key)
        }

    @Test
    fun theNotifiersOwnTapIntentCarriesItsLink() {
        val tap = notifier.tapIntent("own", nudge)!!
        assertEquals(nudge, AndroidNotifier.tappedDeepLink(context, tap))
        assertEquals(nudge, AndroidNotifier.tappedDeepLink(context, Intent(context, MainActivity::class.java).putExtras(tap)))
        assertNull(AndroidNotifier.tappedDeepLink(context, notifier.tapIntent("no-link", null)))
    }

    @Test
    fun theKeyIsMadeOnceAndKeptOutOfBackups() {
        val key = key()
        assertTrue(Regex("[0-9a-f]{64}").matches(key))
        assertEquals(key, key())
        val file = File(context.noBackupFilesDir, "notification-tap-key")
        assertTrue(file.isFile)
        assertEquals(key, file.readText())
    }

    @Test
    fun aLinkWithoutTheRightKeyIsRefused() {
        val key = key()
        val flipped = key.dropLast(1) + (if (key.last() == '0') '1' else '0')
        for (given in listOf(null, "", "0".repeat(64), flipped, key.uppercase(), key + "0", key.dropLast(1), " $key")) {
            assertNull("key $given", AndroidNotifier.tappedDeepLink(context, forged(nudge, given)))
        }
    }

    @Test
    fun theRightKeyDoesNotCarryAnUnknownLink() {
        val key = key()
        for (link in listOf("caddie://connect?url=https%3A%2F%2Felsewhere.example", "caddie://people?around=1&x=1", "https://elsewhere.example/", "CADDIE://inbox")) {
            assertNull(link, AndroidNotifier.tappedDeepLink(context, forged(link, key)))
        }
    }

    @Test
    fun aTapReplayedFromRecentsIsNotANewTap() {
        val tap = notifier.tapIntent("recents", nudge)!!.addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)
        assertNull(AndroidNotifier.tappedDeepLink(context, tap))
    }

    @Test
    fun aColdStartWithoutTheKeyDeliversNothing() {
        ActivityScenario.launch<MainActivity>(forged(nudge)).use {
            Thread.sleep(500)
            assertEquals(emptyList<String>(), taps.toList())
        }
        ActivityScenario.launch<MainActivity>(forged(nudge, "0".repeat(64))).use {
            Thread.sleep(500)
            assertEquals(emptyList<String>(), taps.toList())
        }
    }

    @Test
    fun theRunningActivityTakesOnlyTheNotifiersOwnTap() {
        // Started the way the launcher starts it, in the app's own task.
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)!!
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val activity: Activity = instrumentation.startActivitySync(launch)
        try {
            val flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            // A new intent without the key, as another app would send it, reaches onNewIntent and is ignored.
            context.startActivity(forged("caddie://inbox").addFlags(flags))
            instrumentation.waitForIdleSync()
            Thread.sleep(500)
            assertEquals(emptyList<String>(), taps.toList())

            context.startActivity(notifier.tapIntent("warm", "caddie://inbox")!!)
            waitFor { taps.isNotEmpty() }
            assertEquals(listOf("caddie://inbox"), taps.toList())
            // The activity keeps neither the link nor the key once it has handed the tap over.
            instrumentation.waitForIdleSync()
            var kept: Intent? = null
            instrumentation.runOnMainSync { kept = activity.intent }
            assertNotNull(kept)
            assertNull(kept!!.getStringExtra(AndroidNotifier.EXTRA_DEEP_LINK))
            assertNull(kept!!.getStringExtra(AndroidNotifier.EXTRA_TAP_KEY))
        } finally {
            activity.finish()
        }
    }
}
