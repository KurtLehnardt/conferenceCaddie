package app.conferencecaddie.shared.ble

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The build's switch for Bluetooth proximity ([bleEnabledInBuild]): on in Debug builds, off in Release ones. */
class IosBleBuildTest {
    @Test
    fun onlyYesInTheInfoPlistEnablesBluetooth() {
        assertEquals("CADDIE_BLE_ENABLED", BLE_ENABLED_KEY)
        assertTrue(bleEnabledInBuild("YES"))
        assertFalse(bleEnabledInBuild("NO"))
        assertFalse(bleEnabledInBuild(null), "no key")
        assertFalse(bleEnabledInBuild("\$(CADDIE_BLE_ENABLED)"), "a build setting left undefined")
        assertFalse(bleEnabledInBuild("yes"))
        assertFalse(bleEnabledInBuild(true))
        // The test process has no app Info.plist, so the feature is off there.
        assertFalse(bleEnabledInBuild())
    }
}
