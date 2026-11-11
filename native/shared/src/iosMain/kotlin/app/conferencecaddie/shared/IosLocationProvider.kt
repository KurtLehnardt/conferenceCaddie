package app.conferencecaddie.shared

import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.ObjCSignatureOverride
import kotlinx.cinterop.useContents
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import platform.CoreLocation.CLAccuracyAuthorization
import platform.CoreLocation.CLLocation
import platform.CoreLocation.CLLocationManager
import platform.CoreLocation.CLLocationManagerDelegateProtocol
import platform.CoreLocation.kCLAuthorizationStatusAuthorizedAlways
import platform.CoreLocation.kCLAuthorizationStatusAuthorizedWhenInUse
import platform.CoreLocation.kCLAuthorizationStatusDenied
import platform.CoreLocation.kCLAuthorizationStatusNotDetermined
import platform.CoreLocation.kCLAuthorizationStatusRestricted
import platform.CoreLocation.kCLDistanceFilterNone
import platform.CoreLocation.kCLErrorDenied
import platform.CoreLocation.kCLErrorDomain
import platform.CoreLocation.kCLLocationAccuracyBest
import platform.Foundation.NSDate
import platform.Foundation.NSError
import platform.Foundation.NSThread
import platform.Foundation.timeIntervalSince1970
import platform.darwin.NSObject
import platform.darwin.dispatch_get_main_queue
import platform.darwin.dispatch_sync
import kotlin.coroutines.resume

/**
 * [LocationProvider] on Core Location, "when in use" only: the app declares no background mode and
 * never asks for "always". The location manager and its delegate live on the main thread, where
 * Core Location delivers their callbacks; the provider keeps both for its whole life.
 */
@OptIn(ExperimentalForeignApi::class)
class IosLocationProvider : LocationProvider {
    private val delegate = Delegate()
    private val manager: CLLocationManager by lazy {
        onMain {
            CLLocationManager().apply {
                desiredAccuracy = kCLLocationAccuracyBest
                distanceFilter = kCLDistanceFilterNone
                delegate = this@IosLocationProvider.delegate
            }
        }
    }

    override fun access(): LocationAccess {
        val lm = manager
        return when (lm.authorizationStatus) {
            kCLAuthorizationStatusNotDetermined -> LocationAccess.NotAsked
            // Restricted (parental controls, device management) is not the person's choice and cannot
            // be changed in the app's settings.
            kCLAuthorizationStatusRestricted -> LocationAccess.Unavailable
            // Denied is also what an app sees when Location Services are off for the whole phone.
            // Asking the class costs a call to the location daemon, so it happens only here.
            kCLAuthorizationStatusDenied ->
                if (CLLocationManager.locationServicesEnabled()) LocationAccess.Denied else LocationAccess.Unavailable
            kCLAuthorizationStatusAuthorizedWhenInUse, kCLAuthorizationStatusAuthorizedAlways ->
                if (lm.accuracyAuthorization == CLAccuracyAuthorization.CLAccuracyAuthorizationReducedAccuracy) {
                    LocationAccess.Approximate
                } else {
                    LocationAccess.Precise
                }
            else -> LocationAccess.Unavailable
        }
    }

    override suspend fun requestAccess(): LocationAccess = withContext(Dispatchers.Main) {
        val lm = manager
        if (lm.authorizationStatus == kCLAuthorizationStatusNotDetermined) {
            // iOS asks only once; the delegate hears the decision (and nothing while undecided).
            suspendCancellableCoroutine { waiter ->
                delegate.decisionWaiters += waiter
                waiter.invokeOnCancellation { onMain { delegate.decisionWaiters -= waiter } }
                lm.requestWhenInUseAuthorization()
            }
        }
        access()
    }

    override fun fixes(): Flow<GeoFix> = callbackFlow {
        if (access() != LocationAccess.Precise) {
            close()
            return@callbackFlow
        }
        val channel: SendChannel<GeoFix> = this
        onMain {
            delegate.listeners += channel
            if (delegate.listeners.size == 1) manager.startUpdatingLocation()
        }
        awaitClose {
            onMain {
                delegate.listeners -= channel
                if (delegate.listeners.isEmpty()) manager.stopUpdatingLocation()
            }
        }
    }

    /** The location manager's delegate. Every member is used on the main thread only. */
    private class Delegate : NSObject(), CLLocationManagerDelegateProtocol {
        val decisionWaiters = mutableListOf<CancellableContinuation<Unit>>()
        val listeners = mutableListOf<SendChannel<GeoFix>>()

        override fun locationManagerDidChangeAuthorization(manager: CLLocationManager) {
            if (manager.authorizationStatus == kCLAuthorizationStatusNotDetermined) return
            val waiting = decisionWaiters.toList()
            decisionWaiters.clear()
            waiting.forEach { if (it.isActive) it.resume(Unit) }
        }

        override fun locationManager(manager: CLLocationManager, didUpdateLocations: List<*>) {
            val now = NSDate().timeIntervalSince1970
            for (location in didUpdateLocations) {
                val fix = (location as? CLLocation)?.let { fix(it, now) } ?: continue
                listeners.forEach { it.trySend(fix) }
            }
        }

        @ObjCSignatureOverride
        override fun locationManager(manager: CLLocationManager, didFailWithError: NSError) {
            // Denied: the person withdrew the permission while positions were flowing. Other errors
            // (no position yet) pass, and Core Location keeps trying.
            if (didFailWithError.domain == kCLErrorDomain && didFailWithError.code == kCLErrorDenied) {
                listeners.toList().forEach { it.close() }
                listeners.clear()
                manager.stopUpdatingLocation()
            }
        }

        /** A negative horizontal accuracy means the position is invalid; old cached ones are skipped. */
        private fun fix(location: CLLocation, now: Double): GeoFix? {
            if (location.horizontalAccuracy < 0) return null
            val at = location.timestamp.timeIntervalSince1970
            if (now - at > MAX_AGE_S) return null
            return location.coordinate.useContents {
                GeoFix(lat = latitude, lon = longitude, accuracyM = location.horizontalAccuracy, atEpochMillis = (at * 1000).toLong())
            }
        }
    }

    private companion object {
        /** Like the web's maximumAge of 10 seconds. */
        const val MAX_AGE_S = 10.0
    }
}

/** Runs [block] on the main thread, at once when already there. */
internal fun <T> onMain(block: () -> T): T {
    if (NSThread.isMainThread) return block()
    var result: Result<T>? = null
    dispatch_sync(dispatch_get_main_queue()) { result = runCatching(block) }
    return result!!.getOrThrow()
}
