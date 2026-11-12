package app.conferencecaddie.ui.people

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

// Sharing from a talk's people controls and from the Interested list's "Share with people
// interested in these talks", when the card that asked has left the composition (scrolled out of
// its list, or another screen) by the time the answer comes: the message it would have shown comes
// as a toast. The share is held on its way to the fake server, which then fails it.
@OptIn(ExperimentalTestApi::class)
class TalkPeopleActionsUiTest {
    private val rigs = ArrayList<U3Rig>()
    private val talk1 = "$SLUG:1"
    private val talk3 = "$SLUG:3"

    private fun rig(): U3Rig = U3Rig().also { rigs += it }

    @AfterTest
    fun cleanUp() = rigs.forEach { it.close() }

    /** Whether the card is composed; the tests set it false to leave. */
    private val shown = mutableStateOf(true)

    private fun ComposeUiTest.ready(rig: U3Rig) = u3Await(rig) {
        rig.controller.updateContext(rig.context())
        rig.makeVisible()
    }

    /** Holds the next profile write and has the server fail it; returns the hold. */
    private fun U3Rig.failNextShare(): FakePeopleServer.Hold {
        server.failure = FakeFailure.ServerError(503)
        return server.hold("PUT", "/api/people/profile")
    }

    private fun ComposeUiTest.leaveAndAnswer(rig: U3Rig, hold: FakePeopleServer.Hold, tag: String) {
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        shown.value = false
        u3WaitForNoTag(tag)
        hold.release()
        waitUntil(timeoutMillis = 20_000) { rig.toasts.value.isNotEmpty() }
        rig.server.failure = FakeFailure.None
    }

    @Test
    fun aShareForATalkThatFailsAfterItsCardHasLeftSaysSoInAToast() = runComposeUiTest {
        val rig = rig()
        ready(rig)
        u3Show(rig) { state -> if (shown.value) PeopleScreenColumn { TalkPeopleControls(talk1, interested = true, state, rig.host) } }
        onNodeWithTag("share-switch-$talk1").performClick()
        u3WaitForTag("share-notice")

        val hold = rig.failNextShare()
        onNodeWithText(ProfileStrings.SHARE_MY_PROFILE).performClick()
        leaveAndAnswer(rig, hold, "talk-people-$talk1")
        assertEquals(listOf(PeopleError503), rig.toasts.value)
    }

    @Test
    fun aShareForAllThatFailsAfterItsCardHasLeftSaysSoInAToast() = runComposeUiTest {
        val rig = rig()
        ready(rig)
        u3Show(rig) { state -> if (shown.value) PeopleScreenColumn { ShareAllControls(listOf(talk1, talk3), state, rig.host) } }
        onNodeWithTag("share-all-button").performClick()
        u3WaitForTag("share-notice")

        val hold = rig.failNextShare()
        onNodeWithText(ProfileStrings.SHARE_MY_PROFILE).performClick()
        leaveAndAnswer(rig, hold, "share-all")
        assertEquals(listOf(PeopleError503), rig.toasts.value)
    }

    private companion object {
        /** What a share answered with a 503 says. */
        val PeopleError503 = app.conferencecaddie.shared.people.PeopleError.UNAVAILABLE_MESSAGE
    }
}
