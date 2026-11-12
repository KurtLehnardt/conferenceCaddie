package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.people.ReportKind
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

// ReportSheet (web ReportSheet.tsx) from a person's card, over the real controller and
// FakePeopleServer: the reasons, the one confirming step, the exact report the server receives,
// the toast, and the error lines. Run on the iOS simulator and on Android.
@OptIn(ExperimentalTestApi::class)
class ReportSheetUiTest {
    private val rig = U2Rig()

    @AfterTest
    fun cleanUp() = rig.close()

    @Test
    fun reportingAProfileSendsTheReasonAndThanks() = runComposeUiTest {
        u2Ready(rig)
        val ada = rig.server.seedPerson(rig.slug, "Ada Seed", expertise = "Ran eBPF tracing.", speakTopics = listOf("ebpf"))
        u2Show(rig)
        u2WaitForTag("person-${ada.ref}")
        onNodeWithContentDescription(PeopleCommonStrings.optionsFor("Ada Seed")).performClick()
        u2WaitForTag("overflow-menu")
        onNode(hasText(PeopleCommonStrings.REPORT) and hasAnyAncestor(hasTestTag("overflow-menu"))).performClick()
        u2WaitForTag("report-sheet")

        onNodeWithText("Report Ada Seed").assertIsDisplayed()
        onNodeWithText("What's wrong with their profile? They are not told who reported.").assertIsDisplayed()
        for (label in listOf("Harassment", "Hateful content", "Sexual content", "Spam or advertising", "Something else")) {
            onNodeWithText(label).assertExists()
        }
        onNodeWithText(PeopleStrings.REPORT_HINT).assertExists()

        // No reason yet: the one line says so and nothing is sent.
        onNodeWithTag("report-send").performClick()
        u2WaitForText(PeopleStrings.PICK_A_REASON)
        onNodeWithText(PeopleStrings.REPORT_HINT).assertDoesNotExist()
        assertTrue(rig.server.requests("POST", "/api/people/report").isEmpty())

        // Choosing a reason clears it; Report sends exactly the web's body.
        onNodeWithTag("report-reason-spam").assertIsNotSelected().performClick()
        onNodeWithTag("report-reason-spam").assertIsSelected()
        onNodeWithText(PeopleStrings.PICK_A_REASON).assertDoesNotExist()
        onNodeWithText(PeopleStrings.REPORT_HINT).assertExists()
        onNodeWithTag("report-send").performClick()
        waitUntil(timeoutMillis = 20_000) { PeopleStrings.REPORT_THANKS in rig.toasts }
        u2WaitForNoTag("report-sheet")
        runOnIdle { assertNull(rig.host.reporting) }
        val sent = rig.server.requests("POST", "/api/people/report").single().body!!
        val expected: JsonObject = buildJsonObject {
            put("event", rig.slug)
            put("ref", ada.ref)
            putJsonObject("context") {
                put("kind", "profile")
                put("id", ada.ref)
            }
            put("reason", "spam")
        }
        assertEquals(expected, sent)
        assertEquals(Json.encodeToString(JsonObject.serializer(), expected), rig.server.requests("POST", "/api/people/report").single().bodyText)
    }

    @Test
    fun aReportThatFailsSaysWhyAndStaysOpen() = runComposeUiTest {
        u2Ready(rig)
        u2Show(rig)
        u2WaitForTag("people-screen")
        // A profile that is not there any more: 404.
        runOnIdle { rig.host.report(ReportTarget("0123456789abcdef", "Gone Person", ReportKind.Profile, "0123456789abcdef")) }
        u2WaitForTag("report-sheet")
        onNodeWithTag("report-reason-harassment").performClick()
        onNodeWithTag("report-send").performClick()
        u2WaitForText(PeopleStrings.REPORT_NOT_FOUND)
        onNodeWithTag("report-sheet").assertExists()
        onNodeWithTag("report-send").assertIsEnabled()
        assertTrue(PeopleStrings.REPORT_THANKS !in rig.toasts)

        // Cancel closes it without a word.
        onNodeWithText("Cancel").performClick()
        u2WaitForNoTag("report-sheet")
        runOnIdle { assertNull(rig.host.reporting) }
    }

    @Test
    fun theSubjectFollowsWhatIsReported() = runComposeUiTest {
        u2Ready(rig)
        u2Show(rig)
        u2WaitForTag("people-screen")
        runOnIdle { rig.host.report(ReportTarget("0123456789abcdef", "Sam", ReportKind.Meet, "meet-1")) }
        u2WaitForText("What's wrong with this meet-up? They are not told who reported.")
        onNodeWithText("Report Sam").assertIsDisplayed()
        runOnIdle { rig.host.closeReport() }
        u2WaitForNoTag("report-sheet")
        runOnIdle { rig.host.report(ReportTarget("0123456789abcdef", "Sam", ReportKind.Spot, "0123456789abcdef")) }
        u2WaitForText("What's wrong with their spot line? They are not told who reported.")
    }
}
