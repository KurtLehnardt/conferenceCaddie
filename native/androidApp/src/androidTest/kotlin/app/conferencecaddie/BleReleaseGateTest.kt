package app.conferencecaddie

import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.conferencecaddie.shared.AndroidPeopleServices
import app.conferencecaddie.shared.ble.AndroidBleRadio
import app.conferencecaddie.shared.ble.BleRadioService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The release gate of native Bluetooth (CADDIE_BLE_ENABLED, androidApp/build.gradle.kts): a build
 * that leaves it off gets no Bluetooth platform, so the people features hide the switch even where
 * the backend offers Bluetooth, and their restore clears any Bluetooth record. Such a build also
 * declares no Bluetooth permission and no Bluetooth service: build.gradle.kts merges
 * src/ble/AndroidManifest.xml only where the gate is on, and checkReleaseBluetoothManifest fails a
 * release build that declares any of it. Instrumented tests run the debug build, which has it all.
 */
@RunWith(AndroidJUnit4::class)
class BleReleaseGateTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun withBluetoothOffTheBuildHasNoBluetoothPlatform() {
        // What a release build passes.
        assertNull(AndroidPeopleServices.create(context, R.drawable.ic_stat_caddie, bleEnabled = false).ble)
        // And what a caller that forgets the flag gets.
        assertNull(AndroidPeopleServices.create(context, R.drawable.ic_stat_caddie).ble)
    }

    @Test
    @Suppress("DEPRECATION") // getPackageInfo(String, Int) is the call every supported version has.
    fun theDebugBuildDeclaresBluetooth() {
        val info = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS or PackageManager.GET_SERVICES)
        val requested = info.requestedPermissions.orEmpty().toSet()
        for (p in listOf("BLUETOOTH_ADVERTISE", "BLUETOOTH_SCAN", "BLUETOOTH_CONNECT", "FOREGROUND_SERVICE_CONNECTED_DEVICE")) {
            assertTrue(p, "android.permission.$p" in requested)
        }
        val service = info.services.orEmpty().single { it.name == BleRadioService::class.java.name }
        assertFalse(service.exported)
        if (Build.VERSION.SDK_INT >= 29) assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE, service.foregroundServiceType)
    }

    @Test
    fun theDebugBuildHasBluetoothWhereTheDeviceCan() {
        assertTrue("debug builds turn native Bluetooth on", BuildConfig.CADDIE_BLE_ENABLED)
        val ble = AndroidPeopleServices.create(context, R.drawable.ic_stat_caddie, bleEnabled = BuildConfig.CADDIE_BLE_ENABLED).ble
        assertEquals(AndroidBleRadio.isSupported(context), ble != null)
    }
}
