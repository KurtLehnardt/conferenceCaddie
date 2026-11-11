package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.runComposeUiTest
import app.conferencecaddie.shared.people.ApiResult
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.shared.people.Person
import app.conferencecaddie.ui.shell.PeoplePage
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

// "Ask to talk shop" and Wave against the fake server: the prefilled note, Asked, and every refusal
// in the web's words.
@OptIn(ExperimentalTestApi::class)
class AskUiTest {
    private val rigs = ArrayList<U3Rig>()

    private fun rig(): U3Rig = U3Rig().also { rigs += it }

    @AfterTest
    fun cleanUp() = rigs.forEach { it.close() }

    /** Me visible and around in the Expo hall, Ada around in the Hallway, and Ada as the app found her. */
    private fun androidx.compose.ui.test.ComposeUiTest.setUp(rig: U3Rig, myZone: String = "Expo hall"): Pair<FakePerson, Person> = u3Await(rig) {
        rig.controller.updateContext(rig.context())
        rig.makeVisible()
        val ada = rig.seedAda("Hallway")
        check(rig.controller.turnOnPresence(myZone, "") == null)
        val found = (rig.controller.searchPeople(null, around = true) as ApiResult.Ok).value.results.single { it.ref == ada.ref }
        ada to found
    }

    @Test
    fun anAskCarriesThePrefilledNoteAndSaysAsked() = runComposeUiTest {
        val rig = rig()
        val (ada, person) = setUp(rig)
        val (prefill, topic) = PeopleText.askPrefill(person)
        assertEquals("I'd like to compare notes on Ran eBPF tracing for 200 clusters.", prefill)
        assertNull(topic)
        u3Show(rig) { }
        runOnIdle { rig.host.ask(person) }
        u3WaitForTag("ask-sheet")
        onNodeWithText(ConnectStrings.ASK_TITLE).assertIsDisplayed()
        onNodeWithText(ConnectStrings.askTo("Ada Seed")).assertIsDisplayed()
        onNodeWithTag("ask-note").assertTextContains(prefill)
        onNodeWithText(ConnectStrings.noteCount(prefill.length)).assertIsDisplayed()

        onNodeWithTag("ask-send").performClick()
        u3WaitForText(ConnectStrings.ASKED)
        onNodeWithTag("ask-note").assertDoesNotExist()
        val body = rig.calls("POST", "/api/meet").single().body!!
        assertEquals(ada.ref, (body["ref"] as JsonPrimitive).content)
        assertEquals(prefill, (body["note"] as JsonPrimitive).content)
        assertTrue(body["topic_id"] == null || body["topic_id"] == JsonNull)

        onNodeWithText(ConnectStrings.DONE).performClick()
        waitUntil(timeoutMillis = 20_000) { rig.host.asking == null }
        u3WaitForNoTag("ask-sheet")
    }

    @Test
    fun anEmptyNoteIsRefusedOnThePhone() = runComposeUiTest {
        val rig = rig()
        val (_, person) = setUp(rig)
        u3Show(rig) { }
        runOnIdle { rig.host.ask(person) }
        u3WaitForTag("ask-note")
        onNodeWithTag("ask-note").performTextClearance()
        onNodeWithText(ConnectStrings.noteCount(0)).assertIsDisplayed()
        onNodeWithTag("ask-send").performClick()
        u3WaitForText(ConnectStrings.NOTE_EMPTY)
        assertTrue(rig.calls("POST", "/api/meet").isEmpty())
        // Typing clears the error.
        onNodeWithTag("ask-note").performTextInput("Tracing")
        onNodeWithText(ConnectStrings.NOTE_EMPTY).assertDoesNotExist()
        onNodeWithText(ConnectStrings.noteCount(7)).assertIsDisplayed()
    }

    @Test
    fun refusedAsksUseTheWebsWords() = runComposeUiTest {
        val rig = rig()
        val (ada, person) = setUp(rig)
        u3Show(rig) { }
        runOnIdle { rig.host.ask(person) }
        u3WaitForTag("ask-note")

        // The line filter: the server's own words.
        onNodeWithTag("ask-note").performTextReplacement("This is a badword note")
        onNodeWithTag("ask-send").performClick()
        u3WaitForText("That was held back by the filter. Edit it and try again.")

        // Asks are now-only: they must be around, and so must I.
        onNodeWithTag("ask-note").performTextReplacement("Tracing at scale")
        u3Await(rig) { rig.locked { ada.leave() } }
        onNodeWithTag("ask-send").performClick()
        u3WaitForText("They're not around right now.")
        u3Await(rig) { rig.controller.turnOffPresence() }
        onNodeWithTag("ask-send").performClick()
        u3WaitForText("Turn on 'Around and up for a conversation' first.")

        // Blocked either way.
        u3Await(rig) {
            check(rig.controller.turnOnPresence("Expo hall", "") == null)
            rig.locked {
                ada.goAround("Hallway")
                ada.block(me(SLUG)!!.ref)
            }
        }
        onNodeWithTag("ask-send").performClick()
        u3WaitForText(ConnectStrings.ASK_BLOCKED)
        // None of these became an ask.
        assertTrue(rig.state.inbox.askStates.isEmpty())
    }

    @Test
    fun aSecondAskOffersTheOpenMeetUp() = runComposeUiTest {
        val rig = rig()
        val (_, person) = setUp(rig)
        val first = u3Await(rig) { (rig.controller.ask(person, "First") as ApiResult.Ok).value.meetId }
        u3Show(rig) { }
        runOnIdle { rig.host.ask(person) }
        u3WaitForTag("ask-send")
        onNodeWithTag("ask-send").performClick()
        u3WaitForText(ConnectStrings.ASK_OPEN)
        onNodeWithText(PeopleCommonStrings.OPEN_MEET_UP).performClick()
        waitUntil(timeoutMillis = 20_000) { rig.nav.pages == listOf(PeoplePage.Meet(first)) }
        waitUntil(timeoutMillis = 20_000) { rig.host.asking == null }
    }

    @Test
    fun threeDeclinesTodayPauseAsking() = runComposeUiTest {
        val rig = rig()
        val (_, person) = setUp(rig)
        u3Await(rig) {
            for (name in listOf("Bea", "Cy", "Dee")) {
                val other = rig.locked { seedPerson(SLUG, name, around = "Hallway") }
                val id = (rig.controller.ask(Person(other.ref, name), "Hi") as ApiResult.Ok).value.meetId
                rig.locked { other.decline(id) }
            }
        }
        u3Show(rig) { }
        runOnIdle { rig.host.ask(person) }
        u3WaitForTag("ask-send")
        onNodeWithTag("ask-send").performClick()
        u3WaitForText("Three people said not now today. Try again tomorrow.")
    }

    @Test
    fun aWaveToastsAndMarksTheCard() = runComposeUiTest {
        val rig = rig()
        val (ada, person) = setUp(rig, myZone = "Hallway")
        assertTrue(u3Await(rig) { sendWave(person, rig.host) })
        u3WaitForToast(rig, ConnectStrings.WAVED)
        assertTrue(rig.host.hasWaved(ada.ref))
        assertEquals("I'm in Hallway too — want to talk shop?", (rig.calls("POST", "/api/meet").single().body!!["note"] as JsonPrimitive).content)

        // Again: the meet is already open, in the web's words.
        assertFalse(u3Await(rig) { sendWave(person, rig.host) })
        u3WaitForToast(rig, ConnectStrings.ASK_OPEN)
    }
}
