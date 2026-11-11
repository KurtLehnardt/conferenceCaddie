package app.conferencecaddie.shared

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow

/**
 * [LocationProvider] on Android's own LocationManager. The app is distributed as an APK on GitHub
 * and later on F-Droid, without Google Play services, so the fused provider of Play services is not
 * used; on Android 12 and newer the platform's own fused provider is used when the device has one,
 * and otherwise GPS and network positions are both requested.
 *
 * Android cannot tell "never asked" from "refused for good" without an activity, so the provider
 * remembers in a small preferences file whether it has asked, and asks the attached activity
 * ([AndroidPermissions]) whether the system would still show the prompt.
 */
class AndroidLocationProvider(context: Context) : LocationProvider {
    private val app = context.applicationContext
    private val manager: LocationManager? = app.getSystemService(LocationManager::class.java)
    private val prefs by lazy { app.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    override fun access(): LocationAccess {
        val lm = manager ?: return LocationAccess.Unavailable
        if (providers(lm).isEmpty() || !isEnabled(lm)) return LocationAccess.Unavailable
        if (granted(Manifest.permission.ACCESS_FINE_LOCATION)) return LocationAccess.Precise
        if (granted(Manifest.permission.ACCESS_COARSE_LOCATION)) return LocationAccess.Approximate
        if (!prefs.getBoolean(KEY_ASKED, false)) return LocationAccess.NotAsked
        // Asked before: the prompt still shows when Android wants a rationale (refused once).
        return if (AndroidPermissions.shouldShowRationale(Manifest.permission.ACCESS_FINE_LOCATION) == true) {
            LocationAccess.NotAsked
        } else {
            LocationAccess.Denied
        }
    }

    override suspend fun requestAccess(): LocationAccess {
        val before = access()
        if (before == LocationAccess.Precise || before == LocationAccess.Unavailable) return before
        prefs.edit().putBoolean(KEY_ASKED, true).apply()
        // Android 12 and newer need both together; the person then chooses precise or approximate.
        AndroidPermissions.request(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        return access()
    }

    override fun fixes(): Flow<GeoFix> = callbackFlow {
        val lm = manager
        if (lm == null || access() != LocationAccess.Precise) {
            close()
            return@callbackFlow
        }
        val listener = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                fix(location)?.let { trySend(it) }
            }

            // Android 8 to 10 declare these without default bodies; leaving them out crashes there.
            @Deprecated("Deprecated in Android")
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
            override fun onProviderEnabled(provider: String) = Unit
            override fun onProviderDisabled(provider: String) = Unit
        }
        try {
            val providers = providers(lm)
            // Like the web's maximumAge of 10 seconds: a recent position is used straight away.
            providers.mapNotNull { lm.getLastKnownLocation(it) }
                .filter { ageMillis(it) <= MAX_AGE_MS }
                .maxByOrNull { it.elapsedRealtimeNanos }
                ?.let { fix(it) }
                ?.let { trySend(it) }
            for (provider in providers) {
                lm.requestLocationUpdates(provider, MIN_INTERVAL_MS, 0f, listener, Looper.getMainLooper())
            }
        } catch (e: SecurityException) {
            // The permission was withdrawn in between; emit nothing.
            lm.removeUpdates(listener)
            close()
            return@callbackFlow
        }
        awaitClose { lm.removeUpdates(listener) }
    }

    private fun granted(permission: String) =
        app.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun isEnabled(lm: LocationManager): Boolean =
        if (Build.VERSION.SDK_INT >= 28) {
            lm.isLocationEnabled
        } else {
            lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        }

    /** The platform's fused provider on Android 12 and newer when present, else GPS and network. */
    private fun providers(lm: LocationManager): List<String> {
        val all = lm.allProviders
        if (Build.VERSION.SDK_INT >= 31 && LocationManager.FUSED_PROVIDER in all) return listOf(LocationManager.FUSED_PROVIDER)
        return listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).filter { it in all }
    }

    private fun ageMillis(location: Location): Long =
        (SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos) / 1_000_000

    /** A position without an accuracy is of no use to presence, which needs 200 m or better. */
    private fun fix(location: Location): GeoFix? =
        if (!location.hasAccuracy()) {
            null
        } else {
            GeoFix(
                lat = location.latitude,
                lon = location.longitude,
                accuracyM = location.accuracy.toDouble(),
                atEpochMillis = location.time,
            )
        }

    private companion object {
        const val PREFS = "caddie_permissions"
        const val KEY_ASKED = "location_asked"
        const val MIN_INTERVAL_MS = 5_000L
        const val MAX_AGE_MS = 10_000L
    }
}
