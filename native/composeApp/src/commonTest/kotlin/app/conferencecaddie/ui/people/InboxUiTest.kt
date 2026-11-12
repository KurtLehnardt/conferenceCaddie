package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.people.ApiResult
import app.conferencecaddie.ui.shell.PeoplePage
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Requests against the fake server: an ask to me with its note and time left, Accept into Meet up,
// a silent Not now, an ask that ran out, my own asks, and the zone only when the rules allow it.
@OptIn(ExperimentalTestApi::class)
class InboxUiTest {
    private val rigs = ArrayList<U3Rig>()

    private fun rig(): U3Rig = U3Rig().also { rigs += it }

    @AfterTest
    fun cleanUp() = rigs.forEach { it.close() }

    /** Me visible and around in [myZone]; Ada around in [adaZone]. */
    private fun androidx.compose.ui.test.ComposeUiTest.setUp(rig: U3Rig, myZone: String = "Hallway", adaZone: String = "Hallway"): FakePerson = u3Await(rig) {
        rig.controller.updateContext(rig.context())
        rig.makeVisible()
        val ada = rig.seedAda(adaZone)
        check(rig.controller.turnOnPresence(myZone, "") == null)
        ada
    }

    private suspend fun U3Rig.askMe(ada: FakePerson, note: String, topicId: String? = null): String =
        locked { ada.ask(me(SLUG)!!.ref, note, topicId) }

    @Test
    fun anAskToMeShowsItsNoteAndAcceptOpensMeetUp() = runComposeUiTest {
        val rig = rig()
        val ada = setUp(rig)
        val id = u3Await(rig) { rig.askMe(ada, "Can we compare eBPF notes?") }
        u3Show(rig) { state -> InboxScreen(state, rig.host) }
        u3WaitForTag("incoming-$id")
        onNodeWithText(ConnectStrings.REQUESTS).assertIsDisplayed()
        onNodeWithText(ConnectStrings.incomingSameZone("Ada Seed", "Hallway")).assertIsDisplayed()
        onNodeWithText("Platform engineer.").assertIsDisplayed()
        onNodeWithText("Can we compare eBPF notes?").assertIsDisplayed()
        onNodeWithText(ConnectStrings.expiresIn(15)).assertIsDisplayed()
        onNodeWithContentDescription(PeopleCommonStrings.optionsFor("Ada Seed")).assertIsDisplayed()

        onNodeWithTag("accept-$id").performClick()
        waitUntil(timeoutMillis = 20_000) { rig.nav.pages == listOf(PeoplePage.Meet(id)) }
        assertEquals("active", u3Await(rig) { rig.locked { meetState(id) } })
    }

    @Test
    fun aDoubleTapOnAcceptAcceptsOnce() = runComposeUiTest {
        val rig = rig()
        val ada = setUp(rig)
        val id = u3Await(rig) { rig.askMe(ada, "Can we compare eBPF notes?") }
        u3Show(rig) { state -> InboxScreen(state, rig.host) }
        u3WaitForTag("accept-$id")

        // The first Accept is held on its way to the server, so it cannot finish between the taps.
        val path = "/api/meet/$id/accept"
        val hold = rig.server.hold("POST", path)
        doubleTap(onNodeWithTag("accept-$id"))
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        hold.release()
        waitUntil(timeoutMillis = 20_000) { rig.nav.pages == listOf(PeoplePage.Meet(id)) }
        // A later request queues behind any second Accept on its way to the server.
        u3Await(rig) { rig.controller.refreshInbox() }
        assertEquals(1, rig.calls("POST", path).size)
    }

    @Test
    fun notNowIsSilentForTheAsker() = runComposeUiTest {
        val rig = rig()
        val ada = setUp(rig, adaZone = "Expo hall")
        val id = u3Await(rig) { rig.askMe(ada, "", topicId = "ebpf") }
        u3Show(rig) { state -> InboxScreen(state, rig.host) }
        u3WaitForTag("incoming-$id")
        // Not the same zone: the topic, never the zone.
        onNodeWithText(ConnectStrings.incomingTopic("Ada Seed", "eBPF")).assertIsDisplayed()
        assertTrue(u3NoText("Expo hall"))

        onNodeWithTag("decline-$id").performClick()
        u3WaitForNoTag("incoming-$id")
        u3WaitForTag("inbox-empty")
        onNodeWithText(ConnectStrings.NO_REQUESTS).assertIsDisplayed()
        onNodeWithText(ConnectStrings.NO_REQUESTS_BODY).assertIsDisplayed()
        assertTrue(rig.toasts.value.isEmpty())
        // Ada still sees a waiting ask.
        val theirs = u3Await(rig) { rig.locked { actAs(ada.doc, "GET", "/api/meet/inbox?event=$SLUG", null) } }
        val outgoing = (theirs["outgoing"] as JsonArray).single() as JsonObject
        assertEquals("requested", (outgoing["state"] as JsonPrimitive).content)
    }

    @Test
    fun myDeclinedAskStillWaitsAndAnAcceptedOneOpens() = runComposeUiTest {
        val rig = rig()
        val ada = setUp(rig, myZone = "Expo hall")
        val id = u3Await(rig) { (rig.controller.ask(rig.person(ada), "Hello") as ApiResult.Ok).value.meetId }
        u3Show(rig) { state -> InboxScreen(state, rig.host) }
        u3WaitForTag("outgoing-$id")
        onNodeWithText(ConnectStrings.YOUR_REQUESTS).assertIsDisplayed()
        onNodeWithText("Ada Seed").assertIsDisplayed()
        onNodeWithText(PeopleCommonStrings.NO_REPLY_YET).assertIsDisplayed()

        // Ada says not now: nothing changes here.
        u3Await(rig) {
            rig.locked { ada.decline(id) }
            rig.controller.refreshInbox()
        }
        waitForIdle()
        onNodeWithTag("outgoing-$id").assertIsDisplayed()
        onNodeWithText(PeopleCommonStrings.NO_REPLY_YET).assertIsDisplayed()
        assertTrue(u3NoText(ConnectStrings.SAID_NOT_NOW))
    }

    @Test
    fun myAcceptedAskOffersTheMeetUp() = runComposeUiTest {
        val rig = rig()
        val ada = setUp(rig, myZone = "Expo hall")
        val id = u3Await(rig) {
            val id = (rig.controller.ask(rig.person(ada), "Hello") as ApiResult.Ok).value.meetId
            rig.locked { ada.accept(id) }
            id
        }
        u3Show(rig) { state -> InboxScreen(state, rig.host) }
        u3WaitForTag("outgoing-$id")
        u3WaitForText(PeopleCommonStrings.OPEN_MEET_UP)
        onNodeWithText(PeopleCommonStrings.OPEN_MEET_UP).performClick()
        waitUntil(timeoutMillis = 20_000) { rig.nav.pages == listOf(PeoplePage.Meet(id)) }
    }

    @Test
    fun anAskThatRanOutSaysSo() = runComposeUiTest {
        val rig = rig()
        val ada = setUp(rig)
        val id = u3Await(rig) { rig.askMe(ada, "Quick chat?") }
        u3Show(rig) { state -> InboxScreen(state, rig.host) }
        u3WaitForTag("accept-$id")
        rig.clock.advance(16 * 60_000L)
        onNodeWithTag("accept-$id").performClick()
        u3WaitForToast(rig, ConnectStrings.RAN_OUT)
        u3WaitForNoTag("incoming-$id")
        assertTrue(rig.nav.pages.isEmpty())
    }

    @Test
    fun anIncomingAskNamesNoZoneUnlessItIsSameZone() = runComposeUiTest {
        val rig = rig()
        // A server that says too much: a zone on an ask that is not a same-zone one.
        rig.rewrite = { method, path, body ->
            if (method == "GET" && path == "/api/meet/inbox") {
                val incoming = (body["incoming"] as JsonArray).map { m ->
                    val meet = m as JsonObject
                    JsonObject(meet + ("other" to JsonObject((meet["other"] as JsonObject) + ("zone" to JsonPrimitive("Hall B")))))
                }
                JsonObject(body + ("incoming" to JsonArray(incoming)))
            } else {
                body
            }
        }
        val ada = setUp(rig, adaZone = "Expo hall")
        val id = u3Await(rig) { rig.askMe(ada, "Hi") }
        u3Show(rig) { state -> InboxScreen(state, rig.host) }
        u3WaitForTag("incoming-$id")
        onNodeWithText(ConnectStrings.incoming("Ada Seed")).assertIsDisplayed()
        assertTrue(u3NoText("Hall B"))
    }

    @Test
    fun anEmptyInboxSaysNoRequestsYet() = runComposeUiTest {
        val rig = rig()
        setUp(rig)
        u3Show(rig) { state -> InboxScreen(state, rig.host) }
        u3WaitForTag("inbox-empty")
        onNodeWithText(ConnectStrings.NO_REQUESTS).assertIsDisplayed()
        onNodeWithText(ConnectStrings.YOUR_REQUESTS).assertDoesNotExist()
    }
}
