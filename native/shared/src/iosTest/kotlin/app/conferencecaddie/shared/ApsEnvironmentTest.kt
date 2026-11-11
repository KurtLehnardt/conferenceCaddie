package app.conferencecaddie.shared

import kotlin.test.Test
import kotlin.test.assertEquals

/** The APNs environment comes from the signed profile's `aps-environment`, not from the build type. */
class ApsEnvironmentTest {
    private fun profile(entitlements: String): ByteArray {
        // A provisioning profile is a CMS envelope (binary bytes) around an XML property list.
        val envelope = byteArrayOf(0x30, -0x80, 0x06, 0x09, 0x2a, -0x7a, 0x48)
        val plist = """
            <?xml version="1.0" encoding="UTF-8"?>
            <plist version="1.0"><dict>
              <key>Name</key><string>Conference Caddie Development</string>
              <key>Entitlements</key><dict>$entitlements</dict>
            </dict></plist>
        """.trimIndent()
        return envelope + plist.encodeToByteArray() + envelope
    }

    @Test
    fun aDevelopmentProfileMeansTheSandbox() {
        assertEquals("sandbox", ApsEnvironment.fromProfile(profile("<key>aps-environment</key>\n    <string>development</string>")))
    }

    @Test
    fun aProductionProfileMeansProduction() {
        assertEquals("production", ApsEnvironment.fromProfile(profile("<key>aps-environment</key><string>production</string>")))
    }

    @Test
    fun noEntitlementOrNoPropertyListMeansProduction() {
        assertEquals("production", ApsEnvironment.fromProfile(profile("<key>get-task-allow</key><true/>")))
        assertEquals("production", ApsEnvironment.fromProfile(ByteArray(0)))
    }
}
