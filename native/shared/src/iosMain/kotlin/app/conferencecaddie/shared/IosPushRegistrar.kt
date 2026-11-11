package app.conferencecaddie.shared

import kotlin.time.Duration.Companion.seconds
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.UByteVar
import kotlinx.cinterop.get
import kotlinx.cinterop.reinterpret
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import platform.Foundation.NSBundle
import platform.Foundation.NSData
import platform.Foundation.NSError
import platform.Foundation.NSProcessInfo
import platform.Foundation.create
import platform.UIKit.UIApplication
import platform.UIKit.registerForRemoteNotifications
import platform.UIKit.unregisterForRemoteNotifications

/**
 * [PushRegistrar] for APNs. It asks for notification permission through [notifier], then asks iOS
 * for a device token and waits (at most 20 seconds) for the app delegate to hand it to [IosPush].
 *
 * Registering needs the Push Notifications capability, which the app's entitlements request
 * (`aps-environment`). The token's environment is the one the app was signed with, never a guess
 * from the build type: [ApsEnvironment] reads `aps-environment` from the provisioning profile
 * embedded in the app. A development profile gives sandbox tokens; App Store and TestFlight
 * installs carry no embedded profile and always get production tokens.
 *
 * Nothing here touches UIApplication until [register] or [unregister] runs, so tests may build it.
 */
class IosPushRegistrar(private val notifier: Notifier) : PushRegistrar {
    override val channel: String = "apns"

    override suspend fun register(): PushToken? {
        if (!notifier.requestPermission()) return null
        val token = IosPush.awaitToken { UIApplication.sharedApplication.registerForRemoteNotifications() } ?: return null
        return PushToken(channel = channel, token = token, environment = environment())
    }

    override suspend fun unregister() = withContext(Dispatchers.Main) {
        UIApplication.sharedApplication.unregisterForRemoteNotifications()
    }

    private fun environment(): String = ApsEnvironment.ofThisApp()
}

/**
 * The APNs environment this app was signed for. Xcode copies the `aps-environment` entitlement into
 * the signature from the provisioning profile, and a development or ad hoc build keeps that profile
 * as `embedded.mobileprovision` in the app; an App Store or TestFlight install has none and always
 * uses production.
 */
object ApsEnvironment {
    /** "sandbox" or "production". */
    fun ofThisApp(): String {
        val path = NSBundle.mainBundle.pathForResource("embedded", ofType = "mobileprovision")
        val data = path?.let { NSData.create(contentsOfFile = it) }
        val simulator = NSProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] != null
        return resolve(data?.let { bytesOf(it) }, simulator)
    }

    /**
     * The environment for an app with the given embedded [profile] (null when it has none). A
     * simulator build has no profile and no real APNs token, and never reaches production, so it
     * reports the sandbox; a device build without a profile is an App Store or TestFlight install.
     */
    fun resolve(profile: ByteArray?, simulator: Boolean): String = when {
        profile != null -> fromProfile(profile)
        simulator -> SANDBOX
        else -> PRODUCTION
    }

    /**
     * Reads `aps-environment` from a provisioning profile's bytes: a CMS envelope around a plain XML
     * property list. "development" means the sandbox; anything else, or no value, means production.
     */
    fun fromProfile(profile: ByteArray): String {
        val text = profile.decodeToString()
        val start = text.indexOf("<plist")
        val end = text.indexOf("</plist>", start.coerceAtLeast(0))
        if (start < 0 || end < 0) return PRODUCTION
        val plist = text.substring(start, end)
        val key = plist.indexOf("<key>aps-environment</key>")
        if (key < 0) return PRODUCTION
        val value = Regex("^\\s*<string>([^<]*)</string>").find(plist.substring(key + "<key>aps-environment</key>".length))
            ?.groupValues?.get(1)?.trim()
        return if (value == "development") SANDBOX else PRODUCTION
    }

    @OptIn(ExperimentalForeignApi::class)
    private fun bytesOf(data: NSData): ByteArray {
        val length = data.length.toInt()
        val bytes = data.bytes?.reinterpret<UByteVar>() ?: return ByteArray(0)
        return ByteArray(length) { bytes[it].toByte() }
    }

    const val SANDBOX = "sandbox"
    const val PRODUCTION = "production"
}

/** Where the app delegate hands over what iOS answers to a registration for remote notifications. */
object IosPush {
    private val timeout = 20.seconds

    // Main thread only.
    private var pending: CompletableDeferred<String?>? = null

    /** From `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`. */
    fun didRegister(deviceToken: NSData) {
        val token = hex(deviceToken)
        onMain { pending?.complete(token) }
    }

    /** From `application(_:didFailToRegisterForRemoteNotificationsWithError:)`. Only the outcome is kept. */
    @Suppress("UNUSED_PARAMETER")
    fun didFail(error: NSError) {
        onMain { pending?.complete(null) }
    }

    /**
     * Starts a registration with [start] (on the main thread) and returns the token, or null on a
     * failure or after the timeout. Calls while one registration is under way share its answer.
     */
    internal suspend fun awaitToken(start: () -> Unit): String? = withContext(Dispatchers.Main) {
        val waiter = pending ?: CompletableDeferred<String?>().also {
            pending = it
            start()
        }
        try {
            withTimeoutOrNull(timeout) { waiter.await() }
        } finally {
            // Answered, timed out or cancelled: the next call starts a new registration.
            if (pending === waiter) pending = null
        }
    }

    /** The token as APNs providers send it: the bytes in lowercase hex. */
    @OptIn(ExperimentalForeignApi::class)
    internal fun hex(data: NSData): String {
        val length = data.length.toInt()
        val bytes = data.bytes?.reinterpret<UByteVar>() ?: return ""
        val out = StringBuilder(length * 2)
        for (i in 0 until length) {
            val b = bytes[i].toInt()
            out.append(HEX[b shr 4]).append(HEX[b and 0x0f])
        }
        return out.toString()
    }

    private const val HEX = "0123456789abcdef"
}
