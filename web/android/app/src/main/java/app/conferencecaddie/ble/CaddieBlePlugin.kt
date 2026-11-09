package app.conferencecaddie.ble

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.conferencecaddie.R
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * The CaddieBle Capacitor plugin: the JS side of "Find people near me by Bluetooth".
 *
 * Methods: isAvailable, checkPermissions, requestPermissions, start({ token, scan, durationMs }),
 * rotate({ token, durationMs? }), stop(), isRunning(), notify({ title, body, data? }).
 * Events: "sightings" { sightings: [{ token, rssi }] } at most every 10 s, "stopped" { reason }
 * when the service ends for any reason, and "notificationTap" { data } when a nearby notification
 * is tapped (also delivered after a cold start).
 *
 * Which permissions apply depends on the Android version: 12+ (API 31) uses the Bluetooth runtime
 * permissions, declared as never used for location; 8.0 to 11 need the legacy location permission
 * to scan, although no position is ever read. Notifications are a runtime permission from 13.
 */
@CapacitorPlugin(
    name = "CaddieBle",
    permissions = [
        Permission(
            alias = CaddieBlePlugin.ALIAS_BLUETOOTH,
            strings = [
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT,
            ],
        ),
        Permission(alias = CaddieBlePlugin.ALIAS_LOCATION, strings = [Manifest.permission.ACCESS_FINE_LOCATION]),
        Permission(alias = CaddieBlePlugin.ALIAS_NOTIFICATIONS, strings = [Manifest.permission.POST_NOTIFICATIONS]),
    ],
)
class CaddieBlePlugin : Plugin() {

    companion object {
        const val ALIAS_BLUETOOTH = "bluetooth"
        const val ALIAS_LOCATION = "location"
        const val ALIAS_NOTIFICATIONS = "notifications"
    }

    private val sink = object : BleService.Sink {
        override fun onSightings(sightings: List<BleService.Sighting>) {
            val list = JSArray()
            for (s in sightings) list.put(JSObject().put("token", s.token).put("rssi", s.rssi))
            notifyListeners("sightings", JSObject().put("sightings", list))
        }

        override fun onStopped(reason: String) {
            notifyListeners("stopped", JSObject().put("reason", reason))
        }
    }

    override fun load() {
        BleService.ensureChannels(context)
        BleService.sink = sink
        // A nearby notification tapped while the app was closed: the launch intent carries it.
        activity?.intent?.let { deliverTap(it) }
    }

    override fun handleOnNewIntent(intent: Intent?) {
        super.handleOnNewIntent(intent)
        if (intent != null) deliverTap(intent)
    }

    override fun handleOnDestroy() {
        if (BleService.sink === sink) BleService.sink = null
        super.handleOnDestroy()
    }

    private fun deliverTap(intent: Intent) {
        val data = intent.getStringExtra(BleConstants.EXTRA_TAP) ?: return
        intent.removeExtra(BleConstants.EXTRA_TAP)
        // Retained until a listener exists, so a cold start still gets it.
        notifyListeners("notificationTap", JSObject().put("data", data), true)
    }

    // --- Capability ----------------------------------------------------------------------------

    private fun bluetoothAdapter() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private fun rationale(): JSObject =
        JSObject()
            .put(ALIAS_BLUETOOTH, context.getString(R.string.ble_rationale_bluetooth))
            .put(ALIAS_LOCATION, context.getString(R.string.ble_rationale_location))
            .put(ALIAS_NOTIFICATIONS, context.getString(R.string.ble_rationale_notifications))

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val adapter = bluetoothAdapter()
        val hasLe = context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)
        val enabled = adapter?.isEnabled == true
        // The extended-advertising flag reads false while the adapter is off, so it is reported
        // separately and only means something when enabled is true.
        val extended = enabled && adapter?.isLeExtendedAdvertisingSupported == true
        call.resolve(
            JSObject()
                .put("available", adapter != null && hasLe)
                .put("enabled", enabled)
                .put("extended", extended)
                .put("rationale", rationale()),
        )
    }

    // --- Permissions ---------------------------------------------------------------------------

    /** The aliases this Android version needs before start() can work. */
    private fun requiredAliases(): List<String> {
        val out = ArrayList<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) out.add(ALIAS_BLUETOOTH) else out.add(ALIAS_LOCATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) out.add(ALIAS_NOTIFICATIONS)
        return out
    }

    private fun allGranted(): Boolean = requiredAliases().all { getPermissionState(it) == PermissionState.GRANTED }

    private fun permissionsObject(): JSObject {
        val o = JSObject()
        for (alias in requiredAliases()) o.put(alias, getPermissionState(alias).toString())
        o.put("granted", allGranted())
        o.put("rationale", rationale())
        return o
    }

    @PluginMethod
    override fun checkPermissions(call: PluginCall) {
        call.resolve(permissionsObject())
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        val missing = requiredAliases().filter { getPermissionState(it) != PermissionState.GRANTED }
        if (missing.isEmpty()) {
            call.resolve(permissionsObject())
            return
        }
        requestPermissionForAliases(missing.toTypedArray(), call, "permissionsResult")
    }

    @PermissionCallback
    private fun permissionsResult(call: PluginCall) {
        call.resolve(permissionsObject())
    }

    // --- Service control -----------------------------------------------------------------------

    @PluginMethod
    fun start(call: PluginCall) {
        val token = BleService.decodeToken(call.getString("token"))
        if (token == null) {
            call.reject("token must be 16 bytes, base64url", "bad_token")
            return
        }
        val duration = call.getDouble("durationMs")?.toLong() ?: 0L
        if (duration <= 0L) {
            call.reject("durationMs must be positive", "bad_duration")
            return
        }
        val scan = call.getBoolean("scan", true) ?: true
        if (!allGranted()) {
            call.reject("Bluetooth permissions are missing", "permission_denied")
            return
        }
        val adapter = bluetoothAdapter()
        if (adapter == null || !context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
            call.reject("This phone has no Bluetooth LE", "unavailable")
            return
        }
        if (!adapter.isEnabled) {
            call.reject("Bluetooth is off", "bluetooth_off")
            return
        }
        if (!adapter.isLeExtendedAdvertisingSupported) {
            call.reject("This phone's Bluetooth cannot send the code", "unsupported")
            return
        }
        try {
            BleService.start(context, token, scan, duration)
        } catch (e: Exception) {
            call.reject("Could not start the Bluetooth service", "start_failed")
            return
        }
        call.resolve()
    }

    @PluginMethod
    fun rotate(call: PluginCall) {
        val token = BleService.decodeToken(call.getString("token"))
        if (token == null) {
            call.reject("token must be 16 bytes, base64url", "bad_token")
            return
        }
        if (!BleService.running) {
            call.reject("Not running", "not_running")
            return
        }
        val duration = call.getDouble("durationMs")?.toLong()
        try {
            BleService.rotate(context, token, if (duration != null && duration > 0L) duration else null)
        } catch (e: Exception) {
            call.reject("Could not rotate the code", "rotate_failed")
            return
        }
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        BleService.stop(context)
        call.resolve()
    }

    @PluginMethod
    fun isRunning(call: PluginCall) {
        call.resolve(JSObject().put("running", BleService.running))
    }

    // --- Local notification --------------------------------------------------------------------

    @SuppressLint("MissingPermission")
    @PluginMethod
    fun notify(call: PluginCall) {
        val title = call.getString("title")
        val body = call.getString("body")
        if (title.isNullOrBlank() || body.isNullOrBlank()) {
            call.reject("title and body are required", "bad_request")
            return
        }
        val data = call.getString("data")
        val manager = NotificationManagerCompat.from(context)
        val allowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (!allowed || !manager.areNotificationsEnabled()) {
            call.reject("Notifications are off for this app", "notifications_denied")
            return
        }
        val open = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (open == null) {
            call.reject("No launch intent", "no_activity")
            return
        }
        open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (data != null) open.putExtra(BleConstants.EXTRA_TAP, data.take(200))
        val pending = PendingIntent.getActivity(
            context,
            BleConstants.NOTIFICATION_NEARBY,
            open,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, BleConstants.CHANNEL_NEARBY)
            .setSmallIcon(R.drawable.ic_stat_caddie)
            .setContentTitle(title.take(80))
            .setContentText(body.take(240))
            .setStyle(NotificationCompat.BigTextStyle().bigText(body.take(240)))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_SOCIAL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        try {
            manager.notify(BleConstants.NOTIFICATION_NEARBY, notification)
        } catch (e: SecurityException) {
            call.reject("Notifications are off for this app", "notifications_denied")
            return
        }
        call.resolve()
    }
}
