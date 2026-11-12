package app.conferencecaddie

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.conferencecaddie.shared.AndroidPeopleServices
import app.conferencecaddie.shared.ble.AndroidBleRadio
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The release gate of native Bluetooth (CADDIE_BLE_ENABLED, androidApp/build.gradle.kts): a build
 * that leaves it off gets no Bluetooth platform, so the people features hide the switch even where
 * the backend offers Bluetooth, and their restore clears any Bluetooth record.
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
    fun theDebugBuildHasBluetoothWhereTheDeviceCan() {
        assertTrue("debug builds turn native Bluetooth on", BuildConfig.CADDIE_BLE_ENABLED)
        val ble = AndroidPeopleServices.create(context, R.drawable.ic_stat_caddie, bleEnabled = BuildConfig.CADDIE_BLE_ENABLED).ble
        assertEquals(AndroidBleRadio.isSupported(context), ble != null)
    }
}
