package app.conferencecaddie.shared

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CapabilitiesTest {
    // The illustrative document from docs/NATIVE_PLAN.md (section 7.2), with one value per alternative.
    private val tier2Document = """
        {
          "api_version": 1,
          "tier": "free",
          "talks": { "bundle_base": "https://owner.github.io/repo/bundles/", "server_search": false },
          "people": { "enabled": true, "semantic": "client", "presence": true, "gps_bands": true,
                      "meets": true, "circles": true, "reports": true, "live": "websocket" },
          "ble": { "mode": "derived-v1", "service_uuid": "e52c391c-b926-4856-9a38-d46c3c10c733",
                   "near_rssi": -75, "window_s": 600, "sightings_min_interval_s": 60 },
          "push": { "apns": false, "fcm": false, "webpush": true },
          "imports": { "github": "device", "schedule": "device" }
        }
    """.trimIndent()

    @Test
    fun parsesThePlanDocument() {
        val caps = Capabilities.parse(tier2Document)

        assertEquals(1, caps.apiVersion)
        assertEquals(Capabilities.Tier.Free, caps.tier)
        assertEquals("https://owner.github.io/repo/bundles/", caps.talks.bundleBase)
        assertTrue(caps.people.enabled)
        assertEquals("websocket", caps.people.live)
        assertEquals("derived-v1", caps.ble.mode)
        assertEquals(-75, caps.ble.nearRssi)
        assertEquals(60, caps.ble.sightingsMinIntervalSeconds)
        assertTrue(caps.push.webpush)
        assertFalse(caps.push.apns)
    }

    @Test
    fun missingSectionsFallBackToTheDemoDefaults() {
        val caps = Capabilities.parse("""{ "api_version": 1, "tier": "demo" }""")

        assertEquals(Capabilities.Demo, caps)
        assertFalse(caps.people.enabled, "the People tab must stay hidden unless a backend enables it")
    }

    @Test
    fun unknownFieldsAndTiersDoNotBreakParsing() {
        val caps = Capabilities.parse(
            """{ "api_version": 2, "tier": "enterprise", "people": { "enabled": true, "new_flag": 1 }, "extra": {} }""",
        )

        assertEquals(2, caps.apiVersion)
        assertEquals(Capabilities.Tier.Demo, caps.tier)
        assertTrue(caps.people.enabled)
    }

    @Test
    fun legacyBackendsGetTheFullPeopleFeatureSet() {
        assertTrue(Capabilities.Legacy.people.enabled)
        assertEquals(Capabilities.Tier.Paid, Capabilities.Legacy.tier)
    }
}
