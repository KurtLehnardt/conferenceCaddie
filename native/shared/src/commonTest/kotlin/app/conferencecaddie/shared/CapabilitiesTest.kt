package app.conferencecaddie.shared

import app.conferencecaddie.shared.Capabilities.Negotiation
import app.conferencecaddie.shared.fixtures.Fixtures
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

// The capabilities contract's consumer rules (docs/contracts/capabilities.md), checked against the
// contract fixtures, as test/contracts-capabilities.test.mjs checks the reference implementation.
class CapabilitiesTest {
    private fun doc(text: String): JsonElement = Json.parseToJsonElement(text)

    private fun JsonObject.with(section: String, key: String, value: JsonElement): JsonObject =
        JsonObject(this + (section to JsonObject(this.getValue(section).jsonObject + (key to value))))

    @Test
    fun negotiation() {
        assertEquals(Negotiation.Ok(1), Capabilities.negotiate(Fixtures.capabilities("tier1-demo.json")))
        assertEquals(Negotiation.Ok(1), Capabilities.negotiate(Fixtures.capabilities("forward-compatible-v2.json")))
        assertEquals(Negotiation.UpdateApp, Capabilities.negotiate(Fixtures.capabilities("too-new-v2.json")))
        assertEquals(Negotiation.Invalid, Capabilities.negotiate(doc("{}")), "an empty object is not a document")
        assertEquals(Negotiation.Invalid, Capabilities.negotiate(doc("""{ "api_version": "1" }""")))
        assertEquals(Negotiation.Invalid, Capabilities.negotiate(doc("[]")))
        assertEquals(Negotiation.Invalid, Capabilities.negotiate(null))
        assertEquals(Negotiation.Ok(2), Capabilities.negotiate(doc("""{ "api_version": 3, "min_api_version": 2 }"""), listOf(1, 2)))
        // A min_api_version above api_version is nonsense; it is read as api_version.
        assertEquals(Negotiation.Ok(1), Capabilities.negotiate(doc("""{ "api_version": 1, "min_api_version": 5 }""")))
        assertEquals(Negotiation.Ok(1), Capabilities.negotiate(doc("""{ "api_version": 1.0 }""")), "1.0 is an integer in JSON")
    }

    @Test
    fun aCompleteV1DocumentIsItsOwnEffectiveFeatureSet() {
        for (name in listOf("tier2-free.json", "tier3-paid.json", "tier3-transition.json")) {
            val fixture = Fixtures.capabilities(name)
            assertEquals(Fixtures.asWritten(fixture), Capabilities.effective(fixture).toJson(), name)
        }
    }

    @Test
    fun tier1HasBundlesAndNoPeopleFeatures() {
        val e = Capabilities.effective(Fixtures.capabilities("tier1-demo.json"))
        assertEquals("https://kurtlehnardt.github.io/conferenceCaddie/bundles/", e.talks.bundleBase)
        assertFalse(e.people.enabled)
        assertFalse(e.people.presence)
        assertEquals(Capabilities.Semantic.Off, e.people.semantic)
        assertEquals(Capabilities.BleMode.None, e.ble.mode)
        assertEquals(Capabilities.Imports(), e.imports)
        assertEquals(Capabilities.Tier.Demo, e.tier)
    }

    @Test
    fun legacyIsTheContractsLegacySet() {
        assertEquals(Fixtures.asWritten(Fixtures.capabilities("legacy-effective.json")), Capabilities.Legacy.toJson())
        assertEquals(Capabilities.Legacy, Capabilities.effective(Capabilities.Legacy.toJson()))
        assertEquals(Capabilities.BleMode.ServerRotate, Capabilities.Legacy.ble.mode)
        assertNull(Capabilities.Legacy.talks.bundleBase)
        assertTrue(Capabilities.Legacy.talks.serverSearch)
        // This app implements derived-v1 only, so the legacy server-minted tokens are filtered out
        // separately, without changing the contract's legacy set.
        assertEquals(Capabilities.BleMode.None, Capabilities.Legacy.forThisApp().ble.mode)
        assertTrue(Capabilities.Legacy.forThisApp().people.enabled)
    }

    @Test
    fun forThisAppKeepsDerivedV1AndReadsClientSemanticsAsOff() {
        val tier2 = Capabilities.effective(Fixtures.capabilities("tier2-free.json"))
        assertEquals(Capabilities.Semantic.Client, tier2.people.semantic)
        assertEquals(Capabilities.Semantic.Off, tier2.forThisApp().people.semantic)
        assertEquals(Capabilities.BleMode.DerivedV1, tier2.forThisApp().ble.mode)
        val transition = Capabilities.effective(Fixtures.capabilities("tier3-transition.json"))
        assertEquals(Capabilities.BleMode.ServerRotate, transition.ble.mode)
        assertEquals(Capabilities.BleMode.None, transition.forThisApp().ble.mode)
    }

    @Test
    fun unknownFieldsAreIgnoredAndUnknownValuesFallBackConservatively() {
        val e = Capabilities.effective(Fixtures.capabilities("forward-compatible-v2.json"))
        assertEquals(1, e.apiVersion)
        assertTrue(e.people.enabled)
        assertEquals(Capabilities.Semantic.Off, e.people.semantic)
        assertEquals(Capabilities.Live.Poll, e.people.live)
        assertEquals(Capabilities.BleMode.None, e.ble.mode)
        assertTrue(e.push.fcm)
        assertFalse("operator" in e.toJson())
        assertFalse("chat" in e.toJson().getValue("people").jsonObject)
        assertEquals(Capabilities.Tier.Unknown, Capabilities.effective(doc("""{ "api_version": 1, "tier": "enterprise" }""")).tier)
        assertEquals(
            Capabilities.ImportSite.Device,
            Capabilities.effective(doc("""{ "api_version": 1, "imports": { "github": "cloud", "schedule": "server" } }""")).imports.github,
        )
    }

    @Test
    fun peoplePresenceKeepUntilIsOnOnlyAsTheBooleanTrueWithPresence() {
        fun keep(people: String) =
            Capabilities.effective(doc("""{ "api_version": 1, "people": { "enabled": true, "reports": true, $people } }""")).people.presenceKeepUntil
        assertTrue(keep(""""presence": true, "presence_keep_until": true"""))
        assertFalse(keep(""""presence": true"""), "missing is off")
        assertFalse(keep(""""presence": true, "presence_keep_until": false"""))
        assertFalse(keep(""""presence": true, "presence_keep_until": "true" """), "a string is not a boolean")
        assertFalse(keep(""""presence": true, "presence_keep_until": 1"""))
        assertFalse(keep(""""presence": true, "presence_keep_until": null"""))
        assertFalse(keep(""""presence": true, "presence_keep_until": {}"""))
        assertFalse(keep(""""presence_keep_until": true"""), "it needs presence")
        assertFalse(keep(""""presence": false, "presence_keep_until": true"""), "it needs presence")
        assertFalse(
            Capabilities.effective(doc("""{ "api_version": 1, "people": { "enabled": true, "presence": true, "presence_keep_until": true } }""")).people.presenceKeepUntil,
            "off with the people features (no reports)",
        )
        // A top-level presence group, which no contract has, is not read.
        assertFalse(
            Capabilities.effective(doc("""{ "api_version": 1, "people": { "enabled": true, "reports": true, "presence": true }, "presence": { "keep_until": true } }""")).people.presenceKeepUntil,
        )
        assertFalse(Capabilities.Legacy.people.presenceKeepUntil, "the legacy server refuses until: keep")

        // Written with the other people flags, on or off, and read back the same.
        val on = Capabilities.effective(doc("""{ "api_version": 1, "people": { "enabled": true, "reports": true, "presence": true, "presence_keep_until": true } }"""))
        assertEquals(JsonPrimitive(true), on.toJson().getValue("people").jsonObject["presence_keep_until"])
        assertEquals(on, Capabilities.effective(on.toJson()))
        assertFalse("presence" in on.toJson(), "no top-level presence group")
        val off = Capabilities.effective(doc("""{ "api_version": 1, "people": { "enabled": true, "reports": true, "presence": true } }"""))
        assertEquals(JsonPrimitive(false), off.toJson().getValue("people").jsonObject["presence_keep_until"])
        assertTrue(on.forThisApp().people.presenceKeepUntil)
    }

    @Test
    fun missingFieldsAreOffAndDependentFeaturesTurnOff() {
        val e = Capabilities.effective(doc("""{ "api_version": 1 }"""))
        assertEquals(Capabilities.Talks(null, false), e.talks)
        assertFalse(e.people.enabled)
        assertEquals(Capabilities.BleMode.None, e.ble.mode)
        assertEquals(Capabilities.Push(), e.push)
        assertEquals(Capabilities.Imports(), e.imports)
        assertEquals(Capabilities.Tier.Unknown, e.tier)

        val tier2 = Fixtures.capabilities("tier2-free.json")
        val noReports = Capabilities.effective(tier2.with("people", "reports", JsonPrimitive(false)))
        assertFalse(noReports.people.enabled, "no people features without reports")
        assertEquals(Capabilities.BleMode.None, noReports.ble.mode)

        val noPresence = Capabilities.effective(tier2.with("people", "presence", JsonPrimitive(false)))
        assertEquals(Capabilities.BleMode.None, noPresence.ble.mode, "no Bluetooth without presence")
        assertFalse(noPresence.people.meets, "asks are now-only, so they need presence")
        assertFalse(noPresence.people.gpsBands)
        assertTrue(noPresence.people.circles)

        val notEnabled = Capabilities.effective(tier2.with("people", "enabled", JsonPrimitive("yes")))
        assertFalse(notEnabled.people.enabled, "only the literal true turns a flag on")
    }

    @Test
    fun keepUntilIsOnlyOnWhenTheBackendSaysTrueAndHasPresence() {
        val tier3 = Fixtures.capabilities("tier3-paid.json")
        assertTrue(Capabilities.effective(tier3).people.presenceKeepUntil)
        assertFalse(Capabilities.effective(Fixtures.capabilities("tier2-free.json")).people.presenceKeepUntil)
        assertFalse(Capabilities.Legacy.people.presenceKeepUntil, "the legacy server refuses until: keep")
        assertFalse(Capabilities.effective(tier3.with("people", "presence", JsonPrimitive(false))).people.presenceKeepUntil, "it needs presence")
        assertFalse(Capabilities.effective(tier3.with("people", "presence_keep_until", JsonPrimitive("yes"))).people.presenceKeepUntil)
        val without = JsonObject(tier3 + ("people" to JsonObject(tier3.getValue("people").jsonObject - "presence_keep_until")))
        assertFalse(Capabilities.effective(without).people.presenceKeepUntil, "missing is off")
    }

    @Test
    fun derivedV1UsesTenMinuteWindowsAndClampsTheRest() {
        val tier2 = Fixtures.capabilities("tier2-free.json")
        val e = Capabilities.effective(tier2.with("ble", "window_s", JsonPrimitive(60)).with("ble", "sightings_min_interval_s", JsonPrimitive(900)))
        assertEquals(600, e.ble.windowSeconds)
        assertEquals(60, e.ble.sightingsMinIntervalSeconds)
        assertEquals(-100, Capabilities.effective(tier2.with("ble", "near_rssi", JsonPrimitive(-200))).ble.nearRssi)
        assertEquals(-30, Capabilities.effective(tier2.with("ble", "near_rssi", JsonPrimitive(-10))).ble.nearRssi)
        assertEquals(-75, Capabilities.effective(tier2.with("ble", "near_rssi", JsonPrimitive("loud"))).ble.nearRssi)
        val withoutRule = JsonObject(tier2 + ("ble" to JsonObject(tier2.getValue("ble").jsonObject - "colocation_required")))
        assertTrue(Capabilities.effective(withoutRule).ble.colocationRequired)
        assertTrue(Capabilities.effective(tier2.with("ble", "colocation_required", JsonPrimitive("no"))).ble.colocationRequired)
        assertFalse(Capabilities.effective(tier2.with("ble", "colocation_required", JsonPrimitive(false))).ble.colocationRequired)
        // The service UUID is fixed in v1, whatever the document says.
        assertEquals(Capabilities.SERVICE_UUID, Capabilities.effective(tier2.with("ble", "service_uuid", JsonPrimitive("x"))).ble.serviceUuid)
        // Outside derived-v1 the window may differ but stays in range.
        val transition = Fixtures.capabilities("tier3-transition.json")
        assertEquals(600, Capabilities.effective(transition.with("ble", "window_s", JsonPrimitive(5))).ble.windowSeconds)
    }

    @Test
    fun anHttpOrMalformedBundleBaseIsNotUsed() {
        val tier1 = Fixtures.capabilities("tier1-demo.json")
        val bad = listOf(
            "http://owner.github.io/x/", "https://owner.github.io/x", "https://owner.github.io/x/?a=1", "https://owner.github.io/x/#f",
            "https://user:pw@owner.github.io/x/", "https://user@owner.github.io/x/", "not a url", " https://owner.github.io/x/",
        )
        for (value in bad) {
            assertNull(Capabilities.effective(tier1.with("talks", "bundle_base", JsonPrimitive(value))).talks.bundleBase, value)
        }
        assertNull(Capabilities.effective(tier1.with("talks", "bundle_base", JsonPrimitive(42))).talks.bundleBase)
        val http = Fixtures.capabilities("invalid/http-bundle-base.json")
        assertNull(Capabilities.effective(http).talks.bundleBase)
    }

    @Test
    fun aDebugBuildMayUseALocalHttpBundleBase() {
        val tier1 = Fixtures.capabilities("tier1-demo.json")
        val local = tier1.with("talks", "bundle_base", JsonPrimitive("http://127.0.0.1:8765/bundles/"))
        assertNull(Capabilities.effective(local).talks.bundleBase, "never in release builds")
        assertEquals("http://127.0.0.1:8765/bundles/", Capabilities.effective(local, allowLocalHttpBundleBase = true).talks.bundleBase)
        val remote = tier1.with("talks", "bundle_base", JsonPrimitive("http://example.org/bundles/"))
        assertNull(Capabilities.effective(remote, allowLocalHttpBundleBase = true).talks.bundleBase, "only local hosts")
    }

    @Test
    fun invalidProducerDocumentsStillReadSafely() {
        // A consumer never refuses these; it reads them with the dependency rules applied.
        val noReports = Capabilities.effective(Fixtures.capabilities("invalid/people-without-reports.json"))
        assertFalse(noReports.people.enabled)
        val bleWithoutPeople = Capabilities.effective(Fixtures.capabilities("invalid/ble-without-people.json"))
        assertEquals(Capabilities.BleMode.None, bleWithoutPeople.ble.mode)
        val window = Capabilities.effective(Fixtures.capabilities("invalid/ble-window-not-600.json"))
        assertTrue(window.ble.mode != Capabilities.BleMode.DerivedV1 || window.ble.windowSeconds == 600)
        val interval = Capabilities.effective(Fixtures.capabilities("invalid/interval-over-half-window.json"))
        assertTrue(interval.ble.sightingsMinIntervalSeconds <= 300)
        val unknown = Capabilities.effective(Fixtures.capabilities("invalid/unknown-field-closed-only.json"))
        assertEquals(1, unknown.apiVersion)
    }

    @Test
    fun theEffectiveSetRoundTripsThroughItsJson() {
        for (name in listOf("tier1-demo.json", "tier2-free.json", "forward-compatible-v2.json")) {
            val e = Capabilities.effective(Fixtures.capabilities(name))
            assertEquals(e, Capabilities.effective(e.toJson()), name)
        }
        assertEquals(Capabilities.None, Capabilities.effective(buildJsonObject { put("api_version", 1) }).copy(tier = Capabilities.Tier.Unknown))
    }
}
