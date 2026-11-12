package app.conferencecaddie.ui.people

import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.people.ConferenceInfo
import app.conferencecaddie.shared.people.PeopleError
import app.conferencecaddie.shared.people.PeopleTestHook
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.shared.people.ReportKind
import app.conferencecaddie.ui.shell.PeoplePage
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.CompletableDeferred

// The people screens and sheets (Meet up, the found card, the ask sheet, Unblock in Settings,
// Profile's Shared talks, Requests' Accept and Not now) against the fake server, at the two moments
// where an action used to go wrong.
//
// Leaving: each action is held on its way to the server, and the screen or sheet leaves the
// composition meanwhile (Back, another tab, the sheet dismissed). The answer must still come, as a
// toast, which a coroutine of the screen's own scope could not give.
//
// Double tap: two taps handled before anything else runs on the UI thread (doubleTap), with the
// first action held so it cannot finish between them. A later request, which queues behind any
// second one on the rig's request lock, then shows that one was sent.
@OptIn(ExperimentalTestApi::class)
class PeopleScreenActionsUiTest {
    private val rigs = ArrayList<U3Rig>()

    private fun rig(): U3Rig = U3Rig().also { rigs += it }

    @AfterTest
    fun cleanUp() = rigs.forEach { it.close() }

    /** Whether the screen is composed; the tests set it false to leave. */
    private val shown = mutableStateOf(true)

    private fun ComposeUiTest.show(rig: U3Rig, content: @Composable (PeopleUiState) -> Unit) =
        u3Show(rig) { state -> if (shown.value) content(state) }

    private fun ComposeUiTest.leave(tag: String) {
        shown.value = false
        u3WaitForNoTag(tag)
    }

    /** Me visible and around in the Expo hall, Ada around in the Hallway: an active meet with her. */
    private fun ComposeUiTest.activeMeet(rig: U3Rig): String = u3Await(rig) {
        rig.controller.updateContext(rig.context())
        rig.makeVisible()
        val ada = rig.seedAda("Hallway")
        check(rig.controller.turnOnPresence("Expo hall", "") == null)
        rig.activeMeet(ada)
    }

    /** Me visible and around; Ada, around too, asks me to meet: the ask's id. */
    private fun ComposeUiTest.askedByAda(rig: U3Rig): String = u3Await(rig) {
        rig.controller.updateContext(rig.context())
        rig.makeVisible()
        val ada = rig.seedAda("Hallway")
        check(rig.controller.turnOnPresence("Hallway", "") == null)
        rig.locked { ada.ask(me(SLUG)!!.ref, "Can we compare eBPF notes?", null) }
    }

    /** Waits until the requests asked for so far have been sent, by sending one more after them. */
    private fun ComposeUiTest.afterQueuedRequests(rig: U3Rig) {
        u3Await(rig) { rig.controller.refreshInbox() }
    }

    // --- Meet up ---------------------------------------------------------------------------------

    @Test
    fun weFoundEachOtherIsToastedAfterMeetUpHasLeft() = runComposeUiTest {
        val rig = rig()
        val id = activeMeet(rig)
        show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-found")

        val hold = rig.server.hold("POST", "/api/meet/$id/found")
        onNodeWithTag("meet-found").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        leave("meet-screen")
        hold.release()
        u3WaitForToast(rig, ConnectStrings.youFound("Ada Seed"))
    }

    @Test
    fun aCancelIsToastedAfterMeetUpHasLeft() = runComposeUiTest {
        val rig = rig()
        val id = activeMeet(rig)
        show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-cancel")
        onNodeWithTag("meet-cancel").performScrollTo().performClick()
        u3WaitForTag("meet-cancel-confirm")

        val hold = rig.server.hold("POST", "/api/meet/$id/cancel")
        onNodeWithText(ConnectStrings.CANCEL_MEET_CONFIRM).performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        leave("meet-screen")
        hold.release()
        u3WaitForToast(rig, ConnectStrings.MEET_CANCELLED)
    }

    @Test
    fun aSpotLineSavedAfterMeetUpHasLeftIsToasted() = runComposeUiTest {
        val rig = rig()
        val id = activeMeet(rig)
        show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-spot-me")
        onNodeWithTag("meet-spot-me").performScrollTo().typeText("green hoodie")

        val hold = rig.server.hold("PUT", "/api/meet/$id/details")
        onNodeWithTag("meet-spot-me-save").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        leave("meet-screen")
        hold.release()
        u3WaitForToast(rig, ConnectStrings.SAVED)
    }

    @Test
    fun aMeetingPointSetAfterMeetUpHasLeftIsToasted() = runComposeUiTest {
        val rig = rig()
        val id = activeMeet(rig)
        show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-rendezvous")
        onNodeWithText(ConnectStrings.SET_MEETING_POINT).performScrollTo().performClick()
        u3WaitForTag("meet-rendezvous-set")

        val hold = rig.server.hold("PUT", "/api/meet/$id/details")
        onNodeWithTag("meet-rendezvous-set").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        leave("meet-screen")
        hold.release()
        waitUntil(timeoutMillis = 20_000) { rig.toasts.value.any { it.startsWith("Meet at ") } }
    }

    @Test
    fun aDoubleTapOnWeFoundEachOtherSendsOne() = runComposeUiTest {
        val rig = rig()
        val id = activeMeet(rig)
        show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-found")

        val hold = rig.server.hold("POST", "/api/meet/$id/found")
        doubleTap(onNodeWithTag("meet-found").performScrollTo())
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        hold.release()
        u3WaitForTag("meet-found-card")
        afterQueuedRequests(rig)
        assertEquals(1, rig.calls("POST", "/api/meet/$id/found").size)
    }

    @Test
    fun aDoubleTapOnSaveForTheSpotLineSendsOne() = runComposeUiTest {
        val rig = rig()
        val id = activeMeet(rig)
        show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-spot-me")
        onNodeWithTag("meet-spot-me").performScrollTo().typeText("green hoodie")

        val hold = rig.server.hold("PUT", "/api/meet/$id/details")
        doubleTap(onNodeWithTag("meet-spot-me-save").performScrollTo())
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        hold.release()
        u3WaitForText(ConnectStrings.SAVED)
        afterQueuedRequests(rig)
        assertEquals(1, rig.calls("PUT", "/api/meet/$id/details").size)
    }

    @Test
    fun aDoubleTapOnSaveThisPersonSavesOnce() = runComposeUiTest {
        val rig = rig()
        val id = activeMeet(rig)
        show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-found")
        onNodeWithTag("meet-found").performScrollTo().performClick()
        u3WaitForTag("meet-found-card")

        doubleTap(onNodeWithText(ConnectStrings.SAVE_PERSON))
        waitUntil(timeoutMillis = 20_000) { rig.state.met.isNotEmpty() }
        // A later write runs after any second save.
        u3Await(rig) { rig.controller.retrySession() }
        assertEquals(1, rig.state.met.size)
    }

    @Test
    fun aMeetUpOpenedAgainWhileItsActionIsUnderWayWaitsForIt() = runComposeUiTest {
        val rig = rig()
        val id = activeMeet(rig)
        show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-spot-me")
        onNodeWithTag("meet-spot-me").performScrollTo().typeText("green hoodie")

        // Held once the line is saved and before the action returns, so Meet up can load again.
        val held = HeldAction(rig.controller) { rig.calls("PUT", "/api/meet/$id/details").isNotEmpty() }
        onNodeWithTag("meet-spot-me-save").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { held.hasArrived }
        leave("meet-screen")
        shown.value = true
        u3WaitForTag("meet-found")
        // The Meet up that came back knows an action of this meet-up is under way.
        onNodeWithTag("meet-found").assertIsNotEnabled()
        held.release()
        waitUntil(timeoutMillis = 20_000) { !rig.host.isRunning("meet:$id") }
        assertEquals(1, rig.calls("PUT", "/api/meet/$id/details").size)
    }

    // --- The ask sheet ---------------------------------------------------------------------------

    @Test
    fun anAskSentAfterTheSheetWasClosedIsToasted() = runComposeUiTest {
        val rig = rig()
        val ada = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            val ada = rig.seedAda("Hallway")
            check(rig.controller.turnOnPresence("Hallway", "") == null)
            ada
        }
        show(rig) { }
        runOnIdle { rig.host.ask(rig.person(ada)) }
        u3WaitForTag("ask-send")

        val hold = rig.server.hold("POST", "/api/meet")
        onNodeWithTag("ask-send").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        runOnIdle { rig.host.closeAsk() }
        u3WaitForNoTag("ask-sheet")
        hold.release()
        u3WaitForToast(rig, ConnectStrings.ASKED)
    }

    @Test
    fun aDoubleTapOnSendAsksOnce() = runComposeUiTest {
        val rig = rig()
        val ada = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            val ada = rig.seedAda("Hallway")
            check(rig.controller.turnOnPresence("Hallway", "") == null)
            ada
        }
        show(rig) { }
        runOnIdle { rig.host.ask(rig.person(ada)) }
        u3WaitForTag("ask-send")

        val hold = rig.server.hold("POST", "/api/meet")
        doubleTap(onNodeWithTag("ask-send").performScrollTo())
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        hold.release()
        u3WaitForText(ConnectStrings.ASKED)
        afterQueuedRequests(rig)
        assertEquals(1, rig.calls("POST", "/api/meet").size)
    }

    @Test
    fun anAskSheetOpenedAgainWhileTheAskIsUnderWayWaitsForIt() = runComposeUiTest {
        val rig = rig()
        val ada = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            val ada = rig.seedAda("Hallway")
            check(rig.controller.turnOnPresence("Hallway", "") == null)
            ada
        }
        show(rig) { }
        runOnIdle { rig.host.ask(rig.person(ada)) }
        u3WaitForTag("ask-send")

        val hold = rig.server.hold("POST", "/api/meet")
        onNodeWithTag("ask-send").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        runOnIdle { rig.host.closeAsk() }
        u3WaitForNoTag("ask-sheet")
        runOnIdle { rig.host.ask(rig.person(ada)) }
        u3WaitForTag("ask-send")
        // The sheet opened again knows the ask is under way, and says "Asked" once it is answered.
        onNodeWithTag("ask-send").assertIsNotEnabled()
        hold.release()
        u3WaitForText(ConnectStrings.ASKED)
        assertEquals(1, rig.calls("POST", "/api/meet").size)
    }

    // --- Unblock in Settings ---------------------------------------------------------------------

    /** Ada, blocked by me: her ref. */
    private fun ComposeUiTest.blockedAda(rig: U3Rig): String = u3Await(rig) {
        rig.controller.updateContext(rig.context())
        rig.makeVisible()
        val ada = rig.seedAda("Hallway")
        check(rig.controller.block(ada.ref, ada.displayName) == null)
        ada.ref
    }

    @Test
    fun anUnblockAfterSettingsHasLeftIsToasted() = runComposeUiTest {
        val rig = rig()
        val ref = blockedAda(rig)
        show(rig) { state -> PeopleScreenColumn { BlockedPeople(state, rig.host) } }
        u3WaitForTag("unblock-$ref")

        val hold = rig.server.hold("DELETE", "/api/people/block")
        onNodeWithTag("unblock-$ref").performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        leave("set-blocked")
        hold.release()
        u3WaitForToast(rig, PeopleCommonStrings.unblocked("Ada Seed"))
    }

    @Test
    fun aDoubleTapOnUnblockUnblocksOnce() = runComposeUiTest {
        val rig = rig()
        val ref = blockedAda(rig)
        show(rig) { state -> PeopleScreenColumn { BlockedPeople(state, rig.host) } }
        u3WaitForTag("unblock-$ref")

        val hold = rig.server.hold("DELETE", "/api/people/block")
        doubleTap(onNodeWithTag("unblock-$ref"))
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        hold.release()
        u3WaitForToast(rig, PeopleCommonStrings.unblocked("Ada Seed"))
        afterQueuedRequests(rig)
        assertEquals(1, rig.calls("DELETE", "/api/people/block").size)
    }

    @Test
    fun anotherPersonCanBeUnblockedWhileOneUnblockIsUnderWay() = runComposeUiTest {
        val rig = rig()
        val (ada, bea) = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            val ada = rig.seedAda("Hallway")
            val bea = rig.locked { seedPerson(SLUG, "Bea Seed", about = "Designer.") }
            check(rig.controller.block(ada.ref, ada.displayName) == null)
            check(rig.controller.block(bea.ref, bea.displayName) == null)
            ada.ref to bea.ref
        }
        show(rig) { state -> PeopleScreenColumn { BlockedPeople(state, rig.host) } }
        u3WaitForTag("unblock-$bea")

        // Through the buttons' own actions: the list can be reordered as the server's copy comes in,
        // and a tap aimed at one row would land on the other.
        val hold = rig.server.hold("DELETE", "/api/people/block")
        onNodeWithTag("unblock-$ada").performSemanticsAction(SemanticsActions.OnClick)
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        // Ada's unblock waits for its answer; Bea's is a different person's and goes ahead.
        onNodeWithTag("unblock-$ada").assertIsNotEnabled()
        onNodeWithTag("unblock-$bea").assertIsEnabled().performSemanticsAction(SemanticsActions.OnClick)
        hold.release()
        u3WaitForToast(rig, PeopleCommonStrings.unblocked("Ada Seed"))
        u3WaitForToast(rig, PeopleCommonStrings.unblocked("Bea Seed"))
        assertEquals(2, rig.calls("DELETE", "/api/people/block").size)
    }

    // --- The report sheet --------------------------------------------------------------------------

    @Test
    fun aReportUnderWayNeitherHoldsNorClosesAnotherPersonsSheet() = runComposeUiTest {
        val rig = rig()
        val (ada, bea) = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            val ada = rig.seedAda("Hallway")
            val bea = rig.locked { seedPerson(SLUG, "Bea Seed", about = "Designer.") }
            ada to bea
        }
        show(rig) { }
        val reason = "report-reason-${PeopleStrings.REPORT_REASONS.first().first.name.lowercase()}"
        runOnIdle { rig.host.report(ReportTarget(ada.ref, ada.displayName, ReportKind.Profile, ada.ref)) }
        u3WaitForTag("report-sheet")
        onNodeWithTag(reason).performClick()

        val hold = rig.server.hold("POST", "/api/people/report")
        onNodeWithTag("report-send").performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        // Cancelled while Ada's report is sent, then a report of Bea opened.
        val beaTarget = ReportTarget(bea.ref, bea.displayName, ReportKind.Profile, bea.ref)
        runOnIdle {
            rig.host.closeReport()
            rig.host.report(beaTarget)
        }
        u3WaitForTag("report-sheet")
        onNodeWithTag(reason).performClick()
        onNodeWithTag("report-send").assertIsEnabled()
        hold.release()
        u3WaitForToast(rig, PeopleStrings.REPORT_THANKS)
        // Ada's answer leaves Bea's sheet open, still to be sent.
        waitForIdle()
        assertEquals(beaTarget, rig.host.reporting)
        onNodeWithTag("report-sheet").assertExists()
    }

    // --- Profile's Shared talks ------------------------------------------------------------------

    @Test
    fun stoppingSharingThatFailsAfterProfileHasLeftSaysSoInAToast() = runComposeUiTest {
        val rig = rig()
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            check(rig.controller.shareForTalks(listOf("$SLUG:1")) == null)
        }
        val talks = PeopleTalks(bundle = null, interested = emptyList(), nowMs = 0)
        show(rig) { state -> ProfileScreen(state, rig.host, talks) }
        u3WaitForTag("profile-shared-row")

        rig.server.failure = FakeFailure.ServerError(503)
        val hold = rig.server.hold("PUT", "/api/people/profile")
        onNodeWithText(ProfileStrings.STOP_SHARING_ALL_TALKS).performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        leave("profile-screen")
        hold.release()
        waitUntil(timeoutMillis = 20_000) { rig.toasts.value.isNotEmpty() }
        assertEquals(listOf(PeopleError.UNAVAILABLE_MESSAGE), rig.toasts.value)
        rig.server.failure = FakeFailure.None
    }

    /** Me named, on the profile screen; [visible] makes me visible conference-wide first. */
    private fun ComposeUiTest.onProfile(rig: U3Rig, visible: Boolean) {
        u3Await(rig) {
            // The conference list is known, so a delete knows everywhere the profile may be.
            val listed = listOf(ConferenceInfo(SLUG, "Alpha Conference", "UTC"))
            rig.controller.updateContext(rig.context().copy(listed = listed, listKnown = true))
            if (visible) rig.makeVisible() else rig.controller.updateProfile { it.copy(displayName = "Me Myself") }
        }
        val talks = PeopleTalks(bundle = null, interested = emptyList(), nowMs = 0)
        show(rig) { state -> ProfileScreen(state, rig.host, talks) }
        u3WaitForTag("profile-screen")
    }

    @Test
    fun beingVisibleThatFailsAfterProfileHasLeftSaysSoInAToast() = runComposeUiTest {
        val rig = rig()
        onProfile(rig, visible = false)

        rig.server.failure = FakeFailure.ServerError(503)
        val hold = rig.server.hold("PUT", "/api/people/profile")
        onNodeWithTag("profile-visible").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        leave("profile-screen")
        hold.release()
        waitUntil(timeoutMillis = 20_000) { rig.toasts.value.isNotEmpty() }
        assertEquals(listOf(PeopleError.UNAVAILABLE_MESSAGE), rig.toasts.value)
        rig.server.failure = FakeFailure.None
    }

    @Test
    fun aDeleteThatFinishesAfterProfileHasLeftSaysSoInAToast() = runComposeUiTest {
        val rig = rig()
        onProfile(rig, visible = true)
        onNodeWithTag("profile-delete").performScrollTo().performClick()
        u3WaitForTag("profile-delete-now")

        val hold = rig.server.hold("DELETE", "/api/people/profile")
        onNodeWithTag("profile-delete-now").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        leave("profile-screen")
        hold.release()
        waitUntil(timeoutMillis = 20_000) { rig.toasts.value.isNotEmpty() }
        assertEquals(listOf(DELETED_MESSAGE), rig.toasts.value)
    }

    @Test
    fun tryAgainThatFinishesAfterProfileHasLeftSaysSoInAToast() = runComposeUiTest {
        val rig = rig()
        onProfile(rig, visible = true)
        rig.server.failNextDeletes(1, status = 503)
        onNodeWithTag("profile-delete").performScrollTo().performClick()
        onNodeWithTag("profile-delete-now").performScrollTo().performClick()
        u3WaitForTag("profile-try-again")

        val hold = rig.server.hold("DELETE", "/api/people/profile")
        onNodeWithTag("profile-try-again").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        leave("profile-screen")
        hold.release()
        waitUntil(timeoutMillis = 20_000) { rig.toasts.value.isNotEmpty() }
        assertEquals(listOf(DELETED_MESSAGE), rig.toasts.value)
    }

    @OptIn(PeopleTestHook::class)
    @Test
    fun aDoubleTapOnStopSharingStopsOnce() = runComposeUiTest {
        val rig = rig()
        onProfile(rig, visible = true)
        u3Await(rig) { check(rig.controller.shareForTalks(listOf("$SLUG:1")) == null) }
        u3WaitForTag("profile-shared-row")

        // Each write the controller finishes; the first is held until both taps have been handled.
        val writes = MutableStateFlow(0)
        val gate = CompletableDeferred<Unit>()
        rig.controller.beforeActionReturns = {
            if (writes.updateAndGet { it + 1 } == 1) gate.await()
        }
        doubleTap(onNodeWithText(ProfileStrings.STOP_SHARING_ALL_TALKS).performScrollTo())
        waitUntil(timeoutMillis = 20_000) { writes.value >= 1 }
        gate.complete(Unit)
        // A later one queues behind any second one on the share lock: the tap's and this one, no more.
        u3Await(rig) { rig.controller.unshareAll() }
        rig.controller.beforeActionReturns = {}
        assertEquals(2, writes.value)
    }

    // --- Requests --------------------------------------------------------------------------------

    @Test
    fun anAcceptAfterRequestsHasLeftOffersTheMeetUp() = runComposeUiTest {
        val rig = rig()
        val id = askedByAda(rig)
        show(rig) { state -> InboxScreen(state, rig.host) }
        u3WaitForTag("accept-$id")

        val hold = rig.server.hold("POST", "/api/meet/$id/accept")
        onNodeWithTag("accept-$id").performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        leave("inbox-screen")
        hold.release()
        // Not opened over whatever shows now: the toast offers it.
        u3WaitForToast(rig, ConnectStrings.ACCEPTED_TOAST)
        assertEquals(emptyList(), rig.nav.pages)
        val action = rig.toastActions.value.last()!!
        assertEquals(PeopleCommonStrings.OPEN_MEET_UP, action.label)
        runOnUiThread { action.onClick() }
        waitUntil(timeoutMillis = 20_000) { rig.nav.pages == listOf(PeoplePage.Meet(id)) }
    }

    @Test
    fun aNotNowThatFailsAfterRequestsHasLeftSaysSoInAToast() = runComposeUiTest {
        val rig = rig()
        val id = askedByAda(rig)
        show(rig) { state -> InboxScreen(state, rig.host) }
        u3WaitForTag("decline-$id")

        rig.server.failure = FakeFailure.ServerError(503)
        val hold = rig.server.hold("POST", "/api/meet/$id/decline")
        onNodeWithTag("decline-$id").performClick()
        waitUntil(timeoutMillis = 20_000) { hold.hasArrived }
        leave("inbox-screen")
        hold.release()
        waitUntil(timeoutMillis = 20_000) { rig.toasts.value.isNotEmpty() }
        assertEquals(listOf(PeopleError.UNAVAILABLE_MESSAGE), rig.toasts.value)
        rig.server.failure = FakeFailure.None
    }

    private companion object {
        /** ProfileSync.DELETED_MESSAGE, which the controller returns once "Delete my profile" has finished. */
        const val DELETED_MESSAGE = "Your profile was deleted from this phone and from our server."
    }
}
