package app.conferencecaddie.ui

import app.conferencecaddie.ui.licenses.Licenses
import app.conferencecaddie.ui.licenses.ThirdPartyNotices
import kotlin.test.Test
import kotlin.test.assertTrue

// The licences screen's content: the notices the apps must carry for what they ship.
class LicensesTest {
    private fun section(titlePart: String) = Licenses.SECTIONS.firstOrNull { it.title.contains(titlePart) }

    @Test
    fun everySectionHasATitleAndABody() {
        assertTrue(Licenses.SECTIONS.size >= 3)
        Licenses.SECTIONS.forEach {
            assertTrue(it.title.isNotBlank(), "a section has no title")
            assertTrue(it.body.isNotBlank(), "${it.title} has an empty body")
        }
    }

    @Test
    fun apacheSectionCarriesTheFullLicence() {
        val body = section("Apache License 2.0")?.body
        assertTrue(body != null && "Apache License" in body && "Version 2.0" in body)
        assertTrue("androidx.compose.ui:ui-android" in body || "org.jetbrains.compose.ui:ui" in body)
    }

    @Test
    fun skiaSectionIsIosOnlyBsd() {
        val body = section("Skia")?.body
        assertTrue(body != null && "Redistribution and use in source and binary forms" in body)
        assertTrue("iOS only" in body && "Android only" !in body)
    }

    @Test
    fun lucideLicenceIsPresent() {
        val body = section("Lucide")?.body
        assertTrue(body != null && "ISC License" in body && "Cole Bemis" in body)
    }

    @Test
    fun everyNoticeListsModulesAndText() {
        assertTrue(ThirdPartyNotices.NOTICES.isNotEmpty())
        ThirdPartyNotices.NOTICES.forEach {
            assertTrue(it.android.isNotEmpty() || it.ios.isNotEmpty(), "${it.title} covers no module")
            assertTrue(it.text.isNotBlank(), "${it.title} has no licence text")
        }
    }
}
